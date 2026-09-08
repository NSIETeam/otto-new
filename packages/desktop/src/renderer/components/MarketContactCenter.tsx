import { MarketAssociatedItems } from './MarketAssociatedItems.js';
import { MarketReportForm } from './MarketReportForm.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useState, useRef } from 'react';
import { marketRequest } from '../parkMarketApi.js';
import { startNonOverlappingPoll } from '../lib/nonOverlappingPoll.js';
export function MarketContactComposer({
  listingId,
  version,
}: {
  listingId: string;
  version: number;
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [id, setId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <section aria-label="联系卖家">
      {!open ? (
        <button onClick={() => setOpen(true)}>联系卖家</button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!window.otto.enterpriseMarketSend) {
              setError('当前客户端缺少加密咨询能力');
              return;
            }
            setBusy(true);
            setError('');
            void window.otto
              .enterpriseMarketSend({
                kind: 'listing',
                id: listingId,
                expectedVersion: version,
                question,
                requestId: id,
              })
              .then(() => {
                setSent(true);
                setQuestion('');
              })
              .catch((e) => {
                if (String(e).includes('服务器已明确未发送'))
                  setId(crypto.randomUUID());
                setError(String(e));
              })
              .finally(() => setBusy(false));
          }}
        >
          <p>先问清楚再约交接，发送不代表购买承诺。</p>
          {sent ? (
            <p role="status">问题已发送，请在“我的消息”查看后续咨询。</p>
          ) : (
            <>
              <label>
                你的问题（1–500 字）
                <textarea
                  value={question}
                  disabled={busy}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => setQuestion('还在吗？')}
              >
                填入“还在吗？”
              </button>
              <button disabled={busy || !question.trim()}>
                {busy ? '正在确认发送结果…' : '发送问题'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </button>
            </>
          )}
          {error && (
            <p role="alert">{error}。输入仍保留；超时请用原内容重试。</p>
          )}
        </form>
      )}
    </section>
  );
}
interface Request {
  id: string;
  conversation_id: string;
  sender_id: string;
  recipient_id: string;
  state: string;
  actionable: boolean;
  ignored: boolean;
  paused: boolean;
}
interface Conversation {
  privatePeerId?: string | null;
  id: string;
  account_a: string;
  account_b: string;
}
interface Inbox {
  requests: Request[];
  conversations: Conversation[];
  nextCursor?: string | null;
}
export function MarketContactCenter({
  accountId,
  onOpenPrivate,
}: {
  accountId: string;
  onOpenPrivate?(peerId: string): void;
}) {
  const [state, setState] = useState<Inbox>({
    requests: [],
    conversations: [],
  });
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const loaded = useRef(state);
  loaded.current = state;
  const mutation = useRef(0);
  const [showHistory, setShowHistory] = useState(false);
  const [selected, setSelected] = useState<{
    id: string;
    request?: Request;
  } | null>(null);
  const refresh = useCallback(async () => {
    if (!window.otto.enterpriseParkMarket) return;
    try {
      const started = mutation.current;
      const next = await marketRequest<Inbox>('/contacts');
      const cursors = new Set<string>();
      while (
        next.nextCursor &&
        (next.requests.length < loaded.current.requests.length ||
          next.conversations.length < loaded.current.conversations.length)
      ) {
        if (cursors.has(next.nextCursor)) break;
        cursors.add(next.nextCursor);
        const older = await marketRequest<Inbox>(
          `/contacts?cursor=${encodeURIComponent(next.nextCursor)}`,
        );
        next.requests = [
          ...new Map(
            [...next.requests, ...older.requests].map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ];
        next.conversations = [
          ...new Map(
            [...next.conversations, ...older.conversations].map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ];
        next.nextCursor = older.nextCursor;
      }
      if (started !== mutation.current) return;
      setState(next);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => startNonOverlappingPoll(refresh, 8000), [refresh]);
  const resolve = async (request: Request, action: string) => {
    try {
      mutation.current++;
      await marketRequest(`/contacts/${request.id}`, 'POST', {
        requestId: crypto.randomUUID(),
        action,
      });
      mutation.current++;
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section aria-label="商品咨询">
      <h2>商品咨询</h2>
      {error && <p role="alert">{error}</p>}
      <label>
        <input
          type="checkbox"
          checked={showHistory}
          onChange={(e) => setShowHistory(e.target.checked)}
        />
        显示忽略及已结束请求
      </label>
      {state.nextCursor && (
        <button
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void marketRequest<Inbox>(
              `/contacts?cursor=${encodeURIComponent(state.nextCursor!)}`,
            )
              .then((next) => {
                mutation.current++;
                setState((previous) => ({
                  requests: [
                    ...new Map(
                      [...previous.requests, ...next.requests].map((item) => [
                        item.id,
                        item,
                      ]),
                    ).values(),
                  ],
                  conversations: [
                    ...new Map(
                      [...previous.conversations, ...next.conversations].map(
                        (item) => [item.id, item],
                      ),
                    ).values(),
                  ],
                  nextCursor: next.nextCursor,
                }));
              })
              .catch((error) => setError(String(error)))
              .finally(() => setLoadingMore(false));
          }}
        >
          加载更早咨询记录
        </button>
      )}
      {state.requests
        .filter((r) => showHistory || (r.state === 'pending' && !r.ignored))
        .map((request) => (
          <article key={request.id}>
            <p>
              {request.sender_id === accountId
                ? '发出的商品咨询'
                : '收到的商品咨询'}{' '}
              ·{' '}
              {{
                pending: '等待回复',
                accepted: '已接受',
                withdrawn: '已撤回',
                expired: '已到期',
                ended: '已结束',
              }[request.state] ?? request.state}
              {request.paused ? '（市场暂停，暂不可处理）' : ''}
            </p>
            <button
              onClick={() =>
                setSelected({ id: request.conversation_id, request })
              }
            >
              查看问题和商品
            </button>
            {request.actionable &&
              (request.recipient_id === accountId ? (
                <>
                  <button onClick={() => void resolve(request, 'accept')}>
                    接受，稍后回复
                  </button>
                  <button
                    onClick={() =>
                      setSelected({ id: request.conversation_id, request })
                    }
                  >
                    回复并接受
                  </button>
                  <button onClick={() => void resolve(request, 'ignore')}>
                    忽略
                  </button>
                </>
              ) : (
                <button onClick={() => void resolve(request, 'withdraw')}>
                  撤回请求
                </button>
              ))}
          </article>
        ))}
      {state.conversations.map((thread) => (
        <button
          key={thread.id}
          onClick={() =>
            thread.privatePeerId && onOpenPrivate
              ? onOpenPrivate(thread.privatePeerId)
              : setSelected({ id: thread.id })
          }
        >
          商品会话 ·{' '}
          {thread.account_a === accountId ? thread.account_b : thread.account_a}
        </button>
      ))}
      {selected && (
        <MarketConversation
          key={selected.id}
          id={selected.id}
          accountId={accountId}
          request={state.requests.find((r) => r.id === selected.request?.id)}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </section>
  );
}
function MarketConversation({
  id,
  accountId,
  request,
  onClose,
  onChanged,
}: {
  id: string;
  accountId: string;
  request?: Request;
  onClose(): void;
  onChanged(): Promise<void>;
}) {
  type View = Awaited<
    ReturnType<NonNullable<typeof window.otto.enterpriseMarketMessages>>
  >;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reportListing, setReportListing] = useState('');
  const [reporting, setReporting] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [question, setQuestion] = useState('');
  const [sendId, setSendId] = useState<string>(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      if (!window.otto.enterpriseMarketMessages)
        throw new Error('当前客户端缺少加密咨询能力');
      const next = await window.otto.enterpriseMarketMessages(id);
      setView((previous) =>
        previous
          ? {
              ...next,
              nextBeforeSequence: previous.nextBeforeSequence,
              items: [
                ...new Map(
                  [...previous.items, ...next.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              ].sort((a, b) => a.sequence - b.sequence),
            }
          : next,
      );
      await marketRequest(`/conversations/${id}/read`, 'POST', {
        throughSequence: next.latestSequence,
      });
    } catch (e) {
      setError(String(e));
    }
  }, [id]);
  useEffect(() => startNonOverlappingPoll(refresh, 8000), [refresh]);
  const canReply = request?.recipient_id === accountId && request.actionable;
  return (
    <section aria-label="商品会话">
      <header>
        <h3>商品会话</h3>
        <button onClick={onClose}>关闭会话</button>
      </header>
      {error && <p role="alert">{error}</p>}
      <MarketAssociatedItems
        key={id}
        conversationId={id}
        revision={view?.latestSequence ?? 0}
        onLocate={async (item) => {
          if (!view?.items.some((message) => message.id === item.messageId)) {
            const page = await window.otto.enterpriseMarketMessages!(
              id,
              item.sequence + 1,
            );
            setView((previous) =>
              previous
                ? {
                    ...previous,
                    items: [
                      ...new Map(
                        [...page.items, ...previous.items].map((message) => [
                          message.id,
                          message,
                        ]),
                      ).values(),
                    ].sort((a, b) => a.sequence - b.sequence),
                  }
                : page,
            );
          }
          requestAnimationFrame(() =>
            document
              .getElementById(`market-message-${item.messageId}`)
              ?.scrollIntoView({ block: 'center' }),
          );
        }}
      />
      {view?.nextBeforeSequence && (
        <button
          onClick={() => {
            void window.otto.enterpriseMarketMessages!(
              id,
              view.nextBeforeSequence!,
            )
              .then((page) =>
                setView((previous) =>
                  previous
                    ? {
                        ...previous,
                        nextBeforeSequence: page.nextBeforeSequence,
                        items: [
                          ...new Map(
                            [...page.items, ...previous.items].map((item) => [
                              item.id,
                              item,
                            ]),
                          ).values(),
                        ].sort((a, b) => a.sequence - b.sequence),
                      }
                    : page,
                ),
              )
              .catch((e) => setError(String(e)));
          }}
        >
          加载更早消息
        </button>
      )}
      {view?.canRecoverMls &&
        view.items.some((item) => item.error) &&
        window.otto.enterpriseMarketRecover && (
          <button
            onClick={() => {
              if (
                !window.confirm(
                  '重新建立此会话的加密连接？这不会恢复本机已丢失的历史密钥，原设备保留的历史仍可查看。',
                )
              )
                return;
              void window.otto.enterpriseMarketRecover!(id)
                .then(() => onChanged())
                .catch((e) => setError(String(e)));
            }}
          >
            恢复加密连接
          </button>
        )}
      <div role="log" aria-label="咨询消息">
        {view?.items.map((item) => (
          <article id={`market-message-${item.id}`} key={item.id}>
            <small>
              {item.senderId === accountId ? '我' : '对方'} ·{' '}
              {new Date(item.createdAt).toLocaleString()}
            </small>
            {item.snapshot && (
              <aside>
                <strong>{String(item.snapshot.title)}</strong>
                <p>
                  {item.snapshot.saleMode === 'free'
                    ? '当时免费送'
                    : `当时报价 ¥${(Number(item.snapshot.priceCents) / 100).toFixed(2)}`}
                  {item.snapshot.updated ? ' · 商品信息已更新' : ''}
                  {item.snapshot.unavailable
                    ? ' · 商品不可用'
                    : ` · 当前状态 ${String(item.snapshot.currentState)}`}
                </p>
              </aside>
            )}
            <p>{item.error || item.content}</p>
            {!item.error && (
              <label>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  onChange={(e) =>
                    setSelectedIds((previous) =>
                      e.target.checked
                        ? [...previous, item.id].slice(0, 10)
                        : previous.filter((id) => id !== item.id),
                    )
                  }
                />
                选择作为举报证据
              </label>
            )}
          </article>
        ))}
      </div>
      {view && !view.writable && !canReply && (
        <p>
          当前为只读历史；待处理请求需对方接受，成员资格失效或屏蔽后不能继续市场联系。
        </p>
      )}
      {(view?.writable || canReply) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!window.otto.enterpriseMarketSend) return;
            setBusy(true);
            setError('');
            void window.otto
              .enterpriseMarketSend({
                kind: canReply ? 'reply' : 'conversation',
                id: canReply ? request!.id : id,
                conversationId: id,
                question,
                requestId: sendId,
              })
              .then(async () => {
                setQuestion('');
                setSendId(crypto.randomUUID());
                await refresh();
                await onChanged();
              })
              .catch((e) => {
                if (String(e).includes('服务器已明确未发送'))
                  setSendId(crypto.randomUUID());
                setError(String(e));
              })
              .finally(() => setBusy(false));
          }}
        >
          <label>
            消息
            <textarea
              value={question}
              disabled={busy}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <button disabled={busy || !question.trim()}>
            {busy ? '正在确认结果…' : canReply ? '回复并接受' : '发送消息'}
          </button>
        </form>
      )}
      {selectedIds.length > 0 && (
        <div>
          <label>
            相关商品
            <select
              value={reportListing}
              onChange={(e) => setReportListing(e.target.value)}
            >
              <option value="">请选择关联商品</option>
              {Array.from(
                new Map(
                  view?.items
                    .filter((i) => i.snapshot)
                    .map((i) => [
                      String(i.snapshot!.listingId),
                      String(i.snapshot!.title),
                    ]),
                ).entries(),
              ).map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <button disabled={!reportListing} onClick={() => setReporting(true)}>
            举报所选消息（{selectedIds.length}/10）
          </button>
        </div>
      )}
      {reporting && view && (
        <MarketReportForm
          listingId={reportListing}
          selectedMessages={view.items
            .filter((i) => selectedIds.includes(i.id) && !i.error)
            .map((i) => ({ id: i.id, text: i.content }))}
          onClose={() => setReporting(false)}
          onSubmitted={() => {
            setReporting(false);
            setSelectedIds([]);
          }}
        />
      )}
      {view && (
        <button
          onClick={() => {
            if (
              window.confirm(
                '屏蔽后双方无法通过市场新咨询或继续市场聊天。已有聊天保留，独立企业私聊按原规则运行。',
              )
            )
              void marketRequest(`/blocks/${view.peerId}`, 'PUT', {
                requestId: crypto.randomUUID(),
                enabled: true,
              })
                .then(refresh)
                .catch((e) => setError(String(e)));
          }}
        >
          屏蔽市场联系
        </button>
      )}
      {view && (
        <button
          onClick={() =>
            void marketRequest(`/blocks/${view.peerId}`, 'PUT', {
              requestId: crypto.randomUUID(),
              enabled: false,
            })
              .then(refresh)
              .catch((e) => setError(String(e)))
          }
        >
          解除我的市场屏蔽
        </button>
      )}
    </section>
  );
}

export function MarketPrivateConversation({
  accountId,
  peerId,
}: {
  accountId: string;
  peerId: string;
}) {
  const [thread, setThread] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const inbox = await marketRequest<Inbox>('/contacts');
      setThread(
        inbox.conversations.find((c) => c.privatePeerId === peerId)?.id ?? null,
      );
    } catch {
      setThread(null);
    }
  }, [peerId]);
  useEffect(() => startNonOverlappingPoll(refresh, 8000), [refresh]);
  return thread && !hidden ? (
    <MarketConversation
      key={thread}
      id={thread}
      accountId={accountId}
      onClose={() => setHidden(true)}
      onChanged={refresh}
    />
  ) : thread ? (
    <button onClick={() => setHidden(false)}>查看本会话的商品咨询</button>
  ) : null;
}
