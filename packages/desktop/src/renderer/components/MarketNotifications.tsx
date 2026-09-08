/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useRef, useState } from 'react';
import { startNonOverlappingPoll } from '../lib/nonOverlappingPoll.js';
import { marketRequest } from '../parkMarketApi.js';
export interface MarketNotice {
  id: string;
  kind: string;
  objectId: string;
  createdAt: number;
  readAt: number | null;
}
export interface MarketNoticeState {
  items: MarketNotice[];
  unread: number;
  nextCursor?: string | null;
}
const noticeLabels: Record<string, string> = {
  'expiry-reminder': '商品即将到期，请确认是否继续出售',
  expired: '商品已到期下架',
  'reservation-reminder': '预留时间已到，请检查交接情况',
  'cleanup-reminder': '结束发布的商品内容即将清理',
  'moderation-result': '商品处理结果已更新',
  'moderation-restored': '商品已恢复为下架，请检查后主动上架',
  'report-accepted': '举报已受理',
  'report-result': '举报处理结果已更新',
  'publication-restricted': '发布资格受到限制，请查看原因',
  'publication-restored': '发布限制已撤销',
  'appeal-accepted': '申诉已受理',
  'appeal-result': '申诉处理结果已更新',
};
export function useMarketNotifications(enabled: boolean, scope = '') {
  const empty = (): MarketNoticeState => ({
    items: [],
    unread: 0,
    nextCursor: null,
  });
  const [stored, setStored] = useState({ scope, value: empty() });
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const version = useRef(0);
  const seen = useRef(new Set<string>());
  const state = stored.scope === scope && enabled ? stored.value : empty();
  const loadedCount = useRef(0);
  loadedCount.current = state.items.length;
  useEffect(() => {
    setStored({ scope, value: empty() });
    setError('');
    setLoadingMore(false);
    seen.current.clear();
    version.current++;
    if (!enabled || !window.otto.enterpriseParkMarket) return;
    let current = true;
    const stop = startNonOverlappingPoll(async () => {
      const started = version.current;
      try {
        const next = await marketRequest<MarketNoticeState>('/notifications');
        // Refresh every page already visible so another device's read receipts
        // do not remain stale merely because the notice is older than page one.
        const cursors = new Set<string>();
        while (next.nextCursor && next.items.length < loadedCount.current) {
          if (cursors.has(next.nextCursor)) break;
          cursors.add(next.nextCursor);
          const older = await marketRequest<MarketNoticeState>(
            `/notifications?cursor=${encodeURIComponent(next.nextCursor)}`,
          );
          if (!current || started !== version.current) return;
          next.items = [
            ...new Map(
              [...next.items, ...older.items].map((item) => [item.id, item]),
            ).values(),
          ];
          next.nextCursor = older.nextCursor;
        }
        if (!current || started !== version.current) return;
        setStored({ scope, value: next });
        setError('');
        const unseen = next.items.find(
          (item) => item.readAt === null && !seen.current.has(item.id),
        );
        for (const item of next.items) seen.current.add(item.id);
        if (seen.current.size > 2000)
          seen.current = new Set([...seen.current].slice(-2000));
        if (unseen)
          await window.otto.notificationShow({
            sessionId: 'enterprise:market',
            source: 'enterprise',
            title: '跳蚤市场通知',
            preview: '收到一条商品通知，请在我的消息查看',
            messageId: unseen.id,
            persistent: true,
          });
      } catch (e) {
        if (current) setError(e instanceof Error ? e.message : String(e));
      }
    }, 8000);
    return () => {
      current = false;
      stop();
    };
  }, [enabled, scope]);
  const markRead = async (id: string) => {
    if (currentScope.current !== scope) throw new Error('账号已切换');
    version.current++;
    await marketRequest('/notifications/read', 'POST', { ids: [id] });
    if (currentScope.current !== scope) return;
    version.current++;
    setStored((previous) =>
      previous.scope !== scope
        ? previous
        : {
            scope,
            value: {
              ...previous.value,
              unread: Math.max(
                0,
                previous.value.unread -
                  (previous.value.items.some(
                    (item) => item.id === id && item.readAt === null,
                  )
                    ? 1
                    : 0),
              ),
              items: previous.value.items.map((item) =>
                item.id === id ? { ...item, readAt: Date.now() } : item,
              ),
            },
          },
    );
    await window.otto.notificationMarkRead('enterprise:market');
  };
  const loadMore = async () => {
    if (!state.nextCursor || loadingMore || currentScope.current !== scope)
      return;
    setLoadingMore(true);
    try {
      const next = await marketRequest<MarketNoticeState>(
        `/notifications?cursor=${encodeURIComponent(state.nextCursor)}`,
      );
      if (currentScope.current !== scope) return;
      version.current++;
      setStored((previous) =>
        previous.scope !== scope
          ? previous
          : {
              scope,
              value: {
                ...previous.value,
                nextCursor: next.nextCursor,
                items: [
                  ...previous.value.items,
                  ...next.items.filter(
                    (item) =>
                      !previous.value.items.some((old) => old.id === item.id),
                  ),
                ],
              },
            },
      );
    } finally {
      if (currentScope.current === scope) setLoadingMore(false);
    }
  };
  return { state, error, markRead, loadMore, loadingMore };
}
export function MarketNotifications({
  state,
  error,
  onRead,
  onOpen,
  onLoadMore,
  loadingMore,
}: {
  state: MarketNoticeState;
  error: string;
  onRead(id: string): Promise<void>;
  onOpen?(): void;
  onLoadMore?(): Promise<void>;
  loadingMore?: boolean;
}) {
  const [failure, setFailure] = useState('');
  return (
    <section aria-label="商品通知">
      <h2>商品通知 {state.unread ? `（${state.unread} 条未读）` : ''}</h2>
      {(error || failure) && <p role="alert">{error || failure}</p>}
      {state.items.map((item) => (
        <article key={item.id}>
          <p>{noticeLabels[item.kind] ?? '商品状态已更新，请查看当前记录'}</p>
          <time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
          {item.readAt === null && (
            <button
              onClick={() =>
                void onRead(item.id).catch((e) => setFailure(String(e)))
              }
            >
              标记已读
            </button>
          )}
          <button
            onClick={() => {
              void onRead(item.id)
                .then(() => onOpen?.())
                .catch((e) => setFailure(String(e)));
            }}
          >
            查看记录
          </button>
        </article>
      ))}
      {state.nextCursor && onLoadMore && (
        <button
          disabled={loadingMore}
          onClick={() => void onLoadMore().catch((e) => setFailure(String(e)))}
        >
          加载更早通知
        </button>
      )}
      {!state.items.length && !error && <p>暂无商品通知</p>}
    </section>
  );
}
