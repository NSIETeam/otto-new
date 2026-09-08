/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useRef, useState } from 'react';
import type { WorkableConnectionAction, WorkableConnectionView } from 'otto-server';

export function RecruitmentWorkablePanel({ scopeId, jobId, disabled, onChanged }: { scopeId?: string; jobId?: string; disabled: boolean; onChanged?(): void }): React.JSX.Element {
  const [view, setView] = useState<WorkableConnectionView | null>(null);
  const [selected, setSelected] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [sampleConfirmed, setSampleConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef(new AbortController());
  useEffect(() => {
    operation.current = new AbortController();
    setView(null); setSelected(''); setConfirmed(false); setSampleConfirmed(false); setBusy(false); setLoginBusy(false); setError('');
    return () => {
      operation.current.abort();
      if (scopeId && typeof window.otto.enterpriseRecruitmentWorkableCancel === 'function') void window.otto.enterpriseRecruitmentWorkableCancel(scopeId).catch(() => undefined);
    };
  }, [scopeId, jobId]);
  const run = async (action: WorkableConnectionAction): Promise<void> => {
    const signal = operation.current.signal;
    if (!scopeId || busy || disabled) return;
    setBusy(true); setError('');
    try {
      if (typeof window.otto.enterpriseRecruitmentWorkable !== 'function') throw new Error('请升级客户端与企业服务器后管理 Workable 授权');
      const result = await window.otto.enterpriseRecruitmentWorkable({ scopeId, action });
      if (!signal.aborted) { setView(result); setSelected(''); setConfirmed(false); setSampleConfirmed(false); onChanged?.(); }
    } catch (cause) { if (!signal.aborted) { setView(null); setSelected(''); setConfirmed(false); setSampleConfirmed(false); setError(cause instanceof Error ? cause.message : '授权操作失败，请刷新后重试'); } }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const login = async (): Promise<void> => {
    if (!scopeId || busy || disabled || !confirmed || !view?.authorizationAvailable) return;
    const signal = operation.current.signal;
    setBusy(true); setLoginBusy(true); setError(''); setConfirmed(false); setSampleConfirmed(false);
    try {
      if (typeof window.otto.enterpriseRecruitmentWorkableLogin !== 'function') throw new Error('请升级桌面客户端后使用浏览器授权');
      const result = await window.otto.enterpriseRecruitmentWorkableLogin({ scopeId, expectedRevision: view.revision });
      if (!signal.aborted) { setView(result); setSelected(''); onChanged?.(); }
    } catch (cause) { if (!signal.aborted) { setView(null); setSelected(''); setError(cause instanceof Error ? cause.message : '授权未完成，请刷新后重试'); } }
    finally { if (!signal.aborted) { setBusy(false); setLoginBusy(false); } }
  };
  const locked = disabled || busy || !scopeId;
  const target = selected !== '' ? view?.targets[Number(selected)] : undefined;
  const message = !view ? '先刷新，查看本人 Workable 授权与当前岗位绑定'
    : view.status === 'authorization_required' ? '尚未完成本人 Workable 授权'
      : view.status === 'expired' ? '本人 Workable 授权已过期，需重新授权'
        : view.status === 'binding_required' ? '请为当前 Otto 岗位选择 Workable 岗位'
          : '当前岗位已绑定；是否可检索请查看来源状态，绑定本身不代表已完成真实接入验收';
  return <section className="otto-recruitment-panel" aria-label="Workable 账号与岗位绑定">
    <header><div><strong>Workable · 本人授权与岗位绑定</strong><span>每位招聘同事使用自己的平台授权，仍需拥有当前企业岗位权限。</span></div></header>
    {!jobId ? <p>请先在“企业共享岗位”保存或加载一个岗位，再配置来源绑定。</p> : null}
    <p role="status">{message}</p>
    {view?.authorizationAvailable === false ? <p>浏览器 OAuth 授权入口尚未接通或未由服务器管理员开启。本页不接收令牌，也不能使用同事或管理员的授权代替本人登录。</p> : null}
    {view?.authorizationAvailable ? <p>浏览器登录仅申请读取账号、岗位与候选人。完成后读取本人账号下的已发布岗位供选择；重新授权会清除原岗位绑定，需要重新选择，不会联系候选人。授权到期需重新登录；授权成功不代表通过生产验收。</p> : null}
    {view?.authorizationPending && !loginBusy ? <p>有尚未完成的授权流程；可继续原浏览器流程，或撤销本人授权后重新发起。</p> : null}
    {loginBusy ? <p>请在浏览器完成 Workable 登录；完成后正在校验账号和已发布岗位目录。</p> : null}
    {view?.binding ? <p>当前绑定：{view.binding.account} / {view.binding.shortcode}</p> : null}
    {view?.connectionCheck ? <p role="status">协议与账号检查通过（{new Date(view.connectionCheck.checkedAt).toLocaleString('zh-CN')}）。未验证候选人或简历读取，也未自动开启生产访问；岗位仍以服务器验收配置为准。</p> : null}
    <p>“检查账号连接”只读取平台账号和工具清单，不读取候选人、不调用模型。检查成功不代表人才库检索、简历全文读取或生产验收已通过。</p>
    {view?.materialAcceptanceAvailable ? <section className="otto-recruitment-panel">
      <strong>限定岗位样本验收</strong>
      <p>运维已为本企业、本人和当前岗位设置限期验收许可。此操作读取当前绑定岗位中至多一位候选人及简历，不继续翻页、不调用模型、不联系候选人。只保存时间、完整度与指纹，不保存正文，也不自动开放生产访问。</p>
      <label><input type="checkbox" checked={sampleConfirmed} disabled={locked || !view.binding} onChange={(event) => setSampleConfirmed(event.target.checked)} />我确认此绑定岗位仅用于获准样本验收，允许读取其中一位候选人及简历</label>
      <button type="button" disabled={locked || !jobId || !view.binding || !sampleConfirmed} onClick={() => void run({ kind: 'material_probe', jobId: jobId!, expectedRevision: view.revision, confirmed: true })}>读取一份测试简历（不调用模型）</button>
    </section> : view ? <p>样本读取验收未获限期批准；请让运维限定测试企业、本人和岗位，不要为测试伪造生产已验收标志。</p> : null}
    {view?.materialCheck ? <section className="otto-recruitment-panel">
      <strong>最近一次样本检查 · {new Date(view.materialCheck.checkedAt).toLocaleString('zh-CN')}</strong>
      <p>{({ full_text: '样本正文读取成功；仍需核对内容并完成分析与共享验收', partial: '仅取得部分资料，尚未通过全文读取验收', unavailable: '未取得可用正文，尚未通过全文读取验收', empty: '测试岗位没有候选人，尚未验证简历读取' })[view.materialCheck.status]}</p>
      <p>读取 {view.materialCheck.candidatesRead} 位，提取 {view.materialCheck.materialChars} 个字符；没有模型调用，不代表招聘质量或生产验收通过。</p>
      <details><summary>查看脱敏检查凭据</summary><p>检查编号：{view.materialCheck.runId}</p><p>正文指纹：{view.materialCheck.materialFingerprint ?? '无正文'}</p>{view.materialCheck.attachment ? <p>附件：{view.materialCheck.attachment.format}，{view.materialCheck.attachment.bytes} 字节；摘要 {view.materialCheck.attachment.sha256}</p> : null}</details>
    </section> : null}
    {view?.expiresAt ? <p>授权有效期至：{new Date(view.expiresAt).toLocaleString('zh-CN')}</p> : null}
    <button type="button" disabled={locked} onClick={() => void run({ kind: 'status', jobId: jobId! })}>{busy ? '处理中…' : '刷新本人授权'}</button>
    <label>Workable 账号与岗位<select aria-label="Workable 账号与岗位" value={selected} disabled={locked || !view?.targets.length} onChange={(event) => { setSelected(event.target.value); setConfirmed(false); }}>
      <option value="">请选择已验证的账号与岗位</option>
      {view?.targets.map((entry, index) => <option key={`${entry.account}:${entry.shortcode}`} value={String(index)}>{entry.account} / {entry.label} ({entry.shortcode})</option>)}
    </select></label>
    <p>解除绑定只影响当前岗位；撤销本人授权会清除本人的服务端令牌和全部岗位绑定，不影响同事，也不删除已有候选人档案。平台侧授权仍需在 Workable 中撤销。</p>
    <label><input type="checkbox" checked={confirmed} disabled={locked || !view} onChange={(event) => setConfirmed(event.target.checked)} />我确认本次浏览器只读授权、连接检查、绑定、解除绑定或撤销本人授权操作</label>
    <div className="otto-recruitment-actions">
      <button type="button" disabled={locked || !confirmed || !jobId || !view?.binding} onClick={() => void run({ kind: 'probe', jobId: jobId!, expectedRevision: view!.revision, confirmed: true })}>检查账号连接（只读）</button>
      {view?.authorizationAvailable ? <button type="button" disabled={locked || !confirmed || view.authorizationPending} onClick={() => void login()}>在浏览器登录 Workable</button> : null}
      {loginBusy ? <button type="button" onClick={() => { if (scopeId) void window.otto.enterpriseRecruitmentWorkableCancel(scopeId).catch(() => undefined); }}>取消本次登录</button> : null}
      <button type="button" disabled={locked || !jobId || !confirmed || !target} onClick={() => void run({ kind: 'bind', jobId: jobId!, expectedRevision: view!.revision, account: target!.account, shortcode: target!.shortcode, confirmed: true })}>绑定选中岗位</button>
      <button type="button" disabled={locked || !jobId || !confirmed || !view?.binding} onClick={() => void run({ kind: 'unbind', jobId: jobId!, expectedRevision: view!.revision, confirmed: true })}>解除当前绑定</button>
      <button type="button" disabled={locked || !confirmed || !view || (view.status === 'authorization_required' && !view.authorizationPending)} onClick={() => void run({ kind: 'revoke', expectedRevision: view!.revision, confirmed: true })}>撤销本人全部授权</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
