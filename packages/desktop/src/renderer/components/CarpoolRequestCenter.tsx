import { CarpoolRouteComparison } from './CarpoolRouteComparison.js';
import { CarpoolConfirmation } from './CarpoolConfirmation.js';
import { CarpoolChat } from './CarpoolChat.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useCallback, useEffect, useState } from 'react';
import type { CarpoolWorkflowView, CarpoolWorkflowCommand } from 'otto-server';
import type { EnterpriseParkCarpoolIntent } from '../../preload/index.js';

const REQUEST_LABEL = {
  text: '消息请求',
  carpool_invite: '同行邀请',
  group_join: '入组申请',
  group_invite: '入组邀请',
};
const STATUS_LABEL = {
  pending: '等待对方接受',
  ignored: '已忽略',
  accepted: '已接受',
  rejected: '未接受',
  withdrawn: '已撤回',
  expired: '已失效',
  blocked: '已屏蔽',
};
export function CarpoolRequestCenter({
  onOpenCarpool,
  showCurrentIntent = true,
  stopRequest = 0,
  mode = 'all',
}: {
  onOpenCarpool?: () => void;
  showCurrentIntent?: boolean;
  stopRequest?: number;
  mode?: 'all' | 'personal' | 'admin';
}): React.JSX.Element {
  const [state, setState] = useState<CarpoolWorkflowView | null>(null);
  const [intent, setIntent] = useState<EnterpriseParkCarpoolIntent | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [capacity, setCapacity] = useState(1);
  const [reportTarget, setReportTarget] = useState<{
    requestId: string;
    targetAccountId: string;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [showStop, setShowStop] = useState(false);
  const [blockTarget, setBlockTarget] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [requestFilter, setRequestFilter] = useState<'all' | 'pending'>(
    'pending',
  );
  const [resolution, setResolution] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [workflow, carpool] = await Promise.all([
        window.otto.enterpriseParkCarpoolWorkflowGet(),
        window.otto.enterpriseParkCarpoolGet(),
      ]);
      setState(workflow);
      setIntent(carpool.currentIntent);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void load();
    const changed = () => void load();
    window.addEventListener('otto-carpool-changed', changed);
    return () => window.removeEventListener('otto-carpool-changed', changed);
  }, [load]);
  useEffect(() => {
    if (stopRequest > 0) setShowStop(true);
  }, [stopRequest]);
  const execute = async (command: CarpoolWorkflowCommand) => {
    setBusy(true);
    setError('');
    try {
      setState(await window.otto.enterpriseParkCarpoolWorkflowExecute(command));
      setShowStop(false);
      try {
        setIntent((await window.otto.enterpriseParkCarpoolGet()).currentIntent);
      } catch {
        setError('操作已完成，但当前意向刷新失败；请点击刷新同行消息核对。');
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!intent) return;
    setBusy(true);
    setError('');
    try {
      setIntent(await window.otto.enterpriseParkCarpoolStop(intent.id));
      setShowStop(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={mode === 'admin' ? '园区同行管理' : '同行请求与状态'} className="otto-carpool__requests">
      <header>
        <h2>{mode === 'admin' ? '园区同行管理' : '同行请求与状态'}</h2>
        <button type="button" disabled={busy} onClick={() => void load()}>
          {mode === 'admin' ? '刷新管理数据' : '刷新同行消息'}
        </button>
      </header>
      {mode !== 'admin' ? <>
      {state?.readiness && !state.readiness.approvedDevice ? <p role="status">当前账号尚无已批准的安全设备；请在账号安全设置完成设备批准后使用加密聊天。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!state && !error ? <p role="status">正在读取同行消息…</p> : null}
      {intent && showCurrentIntent ? (
        <article>
          <h3>当前同行状态</h3>
          <p>
            {intent.travelDate} · {intent.origin.label} →{' '}
            {intent.destination.label}
          </p>
          <p>
            {state?.myGroup
              ? `已加入 ${state.myGroup.members.length} 人同行组`
              : intent.status === 'active'
                ? '正在寻找'
                : intent.status === 'paused'
                  ? '已停止'
                  : '已过期'}
          </p>
          {onOpenCarpool ? (
            <button type="button" onClick={onOpenCarpool}>
              查看或修改同行意向
            </button>
          ) : null}
          {intent.status === 'active' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowStop(true)}
            >
              停止寻找
            </button>
          ) : null}
        </article>
      ) : null}
      {showStop ? (
        <CarpoolConfirmation
          label="选择停止方式"
          onCancel={() => setShowStop(false)}
        >
          <p>
            {state?.myGroup
              ? '停止接受新匹配不会退出当前同行组。请选择：'
              : '停止后不再出现在新的匹配结果中。'}
          </p>
          {state?.myGroup ? (
            <>
              <button
                disabled={busy}
                type="button"
                onClick={() =>
                  void execute({ type: 'availability', accepting: false })
                }
              >
                保留同行组，停止接受新匹配
              </button>
              <button
                disabled={busy}
                type="button"
                onClick={() =>
                  void execute({ type: 'leave', stopLooking: true })
                }
              >
                退出同行组并停止寻找
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => void stop()}>
              确认停止
            </button>
          )}
          <button type="button" onClick={() => setShowStop(false)}>
            取消
          </button>
        </CarpoolConfirmation>
      ) : null}
      {state?.myGroup ? (
        <article>
          <h3>我的同行组</h3>
          {intent ? (
            <CarpoolRouteComparison
              intentId={intent.id}
              groupId={state.myGroup.id}
            />
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowStop(true)}
          >
            管理停止与退出
          </button>
          <p>
            {state.myGroup.travelMode === 'private_vehicle'
              ? '私家车同行'
              : '一起叫车'}{' '}
            · {state.myGroup.members.length} 人 ·{' '}
            {state.myGroup.status === 'full'
              ? '已满'
              : state.myGroup.status === 'closed_to_new_members'
                ? '已关闭新申请'
                : '接受新成员'}
          </p>
          <p>
            {state.myGroup.members
              .map(
                (m) =>
                  `${m.displayName}${m.accountId === state.myGroup?.coordinatorAccountId ? '（司机/协调人）' : ''}`,
              )
              .join('、')}
          </p>
          <p>
            剩余乘客名额：
            {Math.max(
              0,
              state.myGroup.passengerCapacity +
                1 -
                state.myGroup.members.length,
            )}
          </p>
          {!state.acceptingNewMatches ? (
            <>
              <p role="status">已停止接受新匹配，当前同行组仍保留</p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void execute({ type: 'availability', accepting: true })
                }
              >
                恢复接受新匹配
              </button>
            </>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void execute({ type: 'leave', stopLooking: false })}
          >
            退出同行组，继续个人寻找
          </button>
          {state.myGroup.coordinatorAccountId === state.accountId
            ? state.myGroup.members
                .filter((m) => m.accountId !== state.accountId)
                .map((m) => (
                  <button
                    type="button"
                    key={m.accountId}
                    disabled={busy}
                    onClick={() =>
                      void execute({
                        type: 'propose_transfer',
                        targetAccountId: m.accountId,
                      })
                    }
                  >
                    提议转交给{m.displayName}
                  </button>
                ))
            : null}
          {state.myGroup.transfer?.to === state.accountId ? (
            <>
              {state.myGroup.travelMode === 'private_vehicle' ? (
                <label>
                  接任后本次乘客容量
                  <select
                    value={capacity}
                    onChange={(event) =>
                      setCapacity(Number(event.target.value))
                    }
                  >
                    <option value={1}>1 人</option>
                    <option value={2}>2 人</option>
                    <option value={3}>3 人</option>
                  </select>
                </label>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void execute({
                    type: 'accept_transfer',
                    passengerCapacity: capacity,
                  })
                }
              >
                同意接任司机/协调人
              </button>
            </>
          ) : null}
        </article>
      ) : null}
      {state?.ownBlockedAccountIds.length ? (
        <section aria-label="已屏蔽的同行账号">
          <h3>已屏蔽的同行账号</h3>
          {state.ownBlockedAccountIds.map((id, index) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() =>
                void execute({ type: 'unblock', targetAccountId: id })
              }
            >
              解除对同行账号 {index + 1} 的屏蔽
            </button>
          ))}
        </section>
      ) : null}
      <label>
        同行请求筛选
        <select
          value={requestFilter}
          onChange={(e) =>
            setRequestFilter(e.target.value as 'all' | 'pending')
          }
        >
          <option value="pending">待处理</option>
          <option value="all">全部请求</option>
        </select>
      </label>
      {state?.requests.length === 0 ? <p>暂无同行请求</p> : null}
      {state?.requests
        .filter(
          (r) =>
            requestFilter === 'all' ||
            ['pending', 'ignored'].includes(r.status),
        )
        .map((request) => {
          const incoming = request.receiverAccountId === state.accountId;
          const target = incoming
            ? request.senderAccountId
            : request.receiverAccountId;
          return (
            <article
              key={request.id}
              aria-label={`${REQUEST_LABEL[request.kind]}：${incoming ? request.senderName : request.receiverName}`}
            >
              <h3>
                {REQUEST_LABEL[request.kind]} ·{' '}
                {incoming ? request.senderName : request.receiverName}
              </h3>
              <p>{request.firstMessage}</p>
              <p>
                约 {request.summary.overlapPercent}% 同路 · 共同方向约{' '}
                {(request.summary.commonDistanceMeters / 1000).toFixed(1)} 公里
              </p>
              {request.travelMode ? (
                <p>
                  {request.travelMode === 'shared_taxi'
                    ? '一起叫车'
                    : request.driverAccountId === request.senderAccountId
                      ? `${request.senderName}开车`
                      : `${request.receiverName}开车`}
                </p>
              ) : null}
              <p role="status">
                {STATUS_LABEL[request.status]}
                {request.invalidReason ? `：${request.invalidReason}` : ''}
              </p>
              {incoming && ['pending', 'ignored'].includes(request.status) ? (
                <>
                  {request.kind === 'carpool_invite' &&
                  request.driverAccountId === state.accountId ? (
                    <label>
                      本次可同行乘客数
                      <select
                        value={capacity}
                        onChange={(e) => setCapacity(Number(e.target.value))}
                      >
                        <option value={1}>1 人</option>
                        <option value={2}>2 人</option>
                        <option value={3}>3 人</option>
                      </select>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void execute({
                        type: 'resolve',
                        requestId: request.id,
                        action: 'accept',
                        passengerCapacity: capacity,
                      })
                    }
                  >
                    {request.kind === 'text'
                      ? '接受聊天'
                      : request.kind === 'group_join'
                        ? '同意入组'
                        : '接受同行邀请'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void execute({
                        type: 'resolve',
                        requestId: request.id,
                        action: request.kind === 'text' ? 'ignore' : 'reject',
                      })
                    }
                  >
                    {request.kind === 'text' ? '忽略' : '拒绝邀请'}
                  </button>
                </>
              ) : null}
              {!incoming && request.status === 'pending' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void execute({
                      type: 'resolve',
                      requestId: request.id,
                      action: 'withdraw',
                    })
                  }
                >
                  撤回请求
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => setBlockTarget(target)}
              >
                屏蔽该用户
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReportTarget({
                    requestId: request.id,
                    targetAccountId: target,
                  });
                  setReason('');
                }}
              >
                举报该请求
              </button>
            </article>
          );
        })}
      {blockTarget ? (
        <CarpoolConfirmation
          label="确认屏蔽同行用户"
          onCancel={() => setBlockTarget(null)}
        >
          <p>
            {state?.myGroup?.members.some(
              (member) => member.accountId === blockTarget,
            )
              ? '你与对方同在一个组。屏蔽后将退出共同的同行组，之后双方不再匹配或收发新消息。'
              : '屏蔽后双方不再匹配或收发新消息，忽略请求不会通知对方。'}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void execute({
                type: 'block',
                targetAccountId: blockTarget,
                leaveSharedGroup: true,
              }).then((success) => {
                if (success) setBlockTarget(null);
              })
            }
          >
            确认屏蔽
            {state?.myGroup?.members.some(
              (member) => member.accountId === blockTarget,
            )
              ? '并退出共同的组'
              : ''}
          </button>
          <button type="button" onClick={() => setBlockTarget(null)}>
            取消
          </button>
        </CarpoolConfirmation>
      ) : null}
      {reportTarget ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void execute({ type: 'report', ...reportTarget, reason }).then(
              (success) => {
                if (success) setReportTarget(null);
              },
            );
          }}
        >
          <p>本条请求内容将提交给园区管理员核查。</p>
          <label>
            举报原因
            <textarea
              required
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button disabled={busy} type="submit">
            提交举报
          </button>
          <button type="button" onClick={() => setReportTarget(null)}>
            取消举报
          </button>
        </form>
      ) : null}
      </> : error ? <p role="alert">{error}</p> : !state ? <p role="status">正在读取园区管理…</p> : null}
      {mode !== 'personal' ? <>
      {state?.metrics ? (
        <section aria-label="园区同行统计">
          <h3>园区同行统计</h3>
          <p>
            有效意向 {state.metrics.activeIntents} · 同行组{' '}
            {state.metrics.activeGroups} · 请求 {state.metrics.requests} ·
            已接受 {state.metrics.acceptedRequests} · 加密消息{' '}
            {state.metrics.ciphertextMessages} · 待处理举报{' '}
            {state.metrics.reportsAwaitingReview}
          </p>
          <p>
            按保留期内用户日统计：打开 {state.metrics.openedUserDays} · 发布{' '}
            {state.metrics.publishedUserDays} · 发布转化{' '}
            {Math.round(state.metrics.publicationConversion * 100)}% · 获得匹配{' '}
            {Math.round(state.metrics.matchedPublisherRatio * 100)}% · 平均候选{' '}
            {state.metrics.averageCandidates.toFixed(1)} · 路线查看{' '}
            {state.metrics.routeViews}
          </p>
          <p>
            消息请求 {state.metrics.textRequests} / 接受{' '}
            {state.metrics.acceptedTextRequests} · 同行邀请及申请{' '}
            {state.metrics.invitations} / 接受{' '}
            {state.metrics.acceptedInvitations} · 曾组成两人及以上{' '}
            {state.metrics.twoPersonUserDays} 用户日 · 曾组成多人{' '}
            {state.metrics.multiPersonUserDays} 用户日 · 主动停止{' '}
            {state.metrics.stoppedIntents} · 屏蔽关系{' '}
            {state.metrics.blockedPairs} · 举报 {state.metrics.reports}
          </p>
          <p>
            地图操作及组规划批次 {state.metrics.mapCalls} · 失败{' '}
            {state.metrics.mapFailures}（
            {Math.round(state.metrics.mapFailureRatio * 100)}%）· 平均耗时{' '}
            {Math.round(state.metrics.averageMapMilliseconds)}{' '}
            毫秒。后台候选查询也计入平均候选；统计不保存坐标。
          </p>
        </section>
      ) : null}
      </> : null}
      {(mode !== 'personal' || !state?.parkAdmin) ? state?.reports.map((report) => (
        <article key={report.id}>
          <h3>举报记录 · {report.status === 'open' ? '待处理' : '已处理'}</h3>
          <p>{report.reason}</p>
          {report.evidence ? (
            <blockquote>
              {report.evidence.kind === 'chat_message'
                ? '举报人主动提交的消息明文（待核实）'
                : '被举报请求'}
              ：{report.evidence.firstMessage}
            </blockquote>
          ) : null}
          {report.resolution ? <p>处理说明：{report.resolution}</p> : null}
          {state.parkAdmin && report.status === 'open' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void execute({
                  type: 'resolve_report',
                  reportId: report.id,
                  resolution,
                });
              }}
            >
              <label>
                处理说明
                <textarea
                  required
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                />
              </label>
              <button disabled={busy} type="submit">
                完成处理
              </button>
            </form>
          ) : null}
        </article>
      )) : null}
      {mode !== 'admin' ? <>
      {state?.conversations.map((conversation) => (
        <button
          key={conversation.id}
          type="button"
          onClick={() => setConversationId(conversation.id)}
        >
          {conversation.kind === 'group' ? '打开同行群聊' : '打开同行私聊'}
          {conversation.status === 'archived' ? '（已归档）' : ''}
        </button>
      ))}
      {conversationId ? (
        <CarpoolChat
          key={conversationId}
          conversationId={conversationId}
          onClose={() => setConversationId(null)}
        />
      ) : null}
      <button type="button" onClick={() => setDeleteConfirmation(true)}>
        删除我的同行数据
      </button>
      {deleteConfirmation ? (
        <CarpoolConfirmation
          label="删除同行数据"
          onCancel={() => setDeleteConfirmation(false)}
        >
          <p>
            将删除你的同行意向、请求和本机加密聊天历史，并退出当前组。已送达其他成员设备的历史无法远程擦除；举报处理记录将去除账号关联。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void window.otto
                .enterpriseParkCarpoolDeleteData()
                .then(() => {
                  setDeleteConfirmation(false);
                  setConversationId(null);
                  window.dispatchEvent(new Event('otto-carpool-data-deleted'));
                  return load();
                })
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            确认删除同行数据
          </button>
          <button type="button" onClick={() => setDeleteConfirmation(false)}>
            取消
          </button>
        </CarpoolConfirmation>
      ) : null}
      {state?.notices.length ? (
        <section aria-label="同行通知">
          <h3>同行通知</h3>
          {state.notices.map((n) => (
            <article key={n.id}>
              <p>{n.text}</p>
              {n.readAt ? (
                <span>已读</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void execute({ type: 'read_notice', noticeId: n.id })
                  }
                >
                  标记已读
                </button>
              )}
            </article>
          ))}
        </section>
      ) : null}
      </> : null}
    </section>
  );
}
