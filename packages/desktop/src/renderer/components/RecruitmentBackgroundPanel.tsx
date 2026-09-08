/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useState } from 'react';
import type { RecruitmentBackgroundState } from 'otto-server';

export function RecruitmentBackgroundPanel({ config, canManage, disabled, onConfigure }: {
  config?: RecruitmentBackgroundState; canManage: boolean; disabled: boolean;
  onConfigure(enabled: boolean, requests: number, tokens: number): Promise<void>;
}): React.JSX.Element {
  const [confirmed, setConfirmed] = useState(false); const [requests, setRequests] = useState(5); const [tokens, setTokens] = useState(100_000);
  useEffect(() => { setConfirmed(false); setRequests(config?.dailyRequestLimit ?? 5); setTokens(config?.dailyReservedTokenLimit ?? 100_000); }, [config?.generation, config?.dailyRequestLimit, config?.dailyReservedTokenLimit]);
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); const usage = config?.usage.find((item) => item.day === today);
  const enterprise = config?.organizationUsage;
  return <section className="otto-recruitment-panel">
    <h4>后台分析 · {config?.enabled ? '已开启' : '默认关闭 / 已暂停'}</h4>
    <p>独立于“接收简历”。只将本岗位要求和待处理箱中的完整简历正文发送到企业管理员批准的模型；不使用企业记忆、面试或实战材料，不联系、淘汰或录用候选人。</p>
    <p>常见身份字段会预先遮盖，但不能保证完全匿名；开启前需确认材料处理权限与模型数据处理约定。缺少企业专属模型授权配置时，服务器会拒绝开启。</p>
    {config ? <p role="status">{config.message} · 模型：{config.modelId || '未配置'}{config.pending ? ' · 请求处理中，暂停不能撤销已产生的费用' : ''}</p> : null}
    <p>本岗位今日（北京时间）：已预留 {usage?.requests ?? 0} / {config?.dailyRequestLimit ?? requests} 次调用，{(usage?.reservedTokens ?? 0).toLocaleString()} / {(config?.dailyReservedTokenLimit ?? tokens).toLocaleString()} Token 额度。已知实际输入 {usage?.inputTokens ?? 0}、输出 {usage?.outputTokens ?? 0}；用量未知 {usage?.unknownRequests ?? 0} 次。</p>
    {enterprise ? <div className="otto-recruitment-panel">
      <p>企业服务器招聘额度快照 · {enterprise.day}（北京时间）· 记录于 {new Date(enterprise.checkedAt).toLocaleString()}，非实时总账</p>
      <p>后台及企业模型单次请求合计：{enterprise.requests} / {enterprise.dailyRequests} 次，{enterprise.reservedTokens.toLocaleString()} / {enterprise.dailyReservedTokens.toLocaleString()} 预留 Token；已知输入 {enterprise.inputTokens}、输出 {enterprise.outputTokens}，用量未知 {enterprise.unknownRequests} 次。</p>
    </div> : <p>尚未取得企业总额度快照；不是零用量。新版服务器要求管理员配置企业总额度后才可开启后台分析。</p>}
    <p>服务器同时检查岗位额度和企业总额度；企业总额由服务器管理员配置。桌面端自带模型的手动分析不计入此额度，尚不是跨所有入口的统一账单。</p>
    <p>企业账本仅统计启用后的服务器调用，不包含升级前已发生的费用；上线时应暂停旧分析服务，核对当日已用额度或次日再开启。</p>
    <p>预留额度按请求大小保守估计，并非真实消耗或人民币账单保证；未知用量不当作零。已取得企业预留的请求失败、暂停或重新开启均不返还当天额度；没有新材料不重复调用，结果未知不会自动重试。</p>
    {canManage ? <>
      <label>每天最多调用次数<input aria-label="每天最多调用次数" type="number" min={1} max={50} value={requests} disabled={disabled} onChange={(event) => setRequests(Number(event.target.value))} /></label>
      <label>每天预留 Token 上限<input aria-label="每天预留 Token 上限" type="number" min={10000} max={2000000} step={10000} value={tokens} disabled={disabled} onChange={(event) => setTokens(Number(event.target.value))} /></label>
      <label><input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => setConfirmed(event.target.checked)} />我确认有权使用上述材料，接受模型费用，并向当前岗位授权同事共享分析结果</label>
      <div className="otto-recruitment-actions">
        <button type="button" disabled={disabled || !confirmed || Boolean(config?.pending)} onClick={() => void onConfigure(false, requests, tokens)}>保存额度，不开启后台</button>
        <button type="button" disabled={disabled || !confirmed || Boolean(config?.pending && Date.parse(config.pending.until) > Date.now())} onClick={() => void onConfigure(true, requests, tokens)}>开启 / 更新后台分析</button>
        <button type="button" disabled={disabled || (!config?.enabled && !config?.pending)} onClick={() => void onConfigure(false, config?.dailyRequestLimit ?? requests, config?.dailyReservedTokenLimit ?? tokens)}>{config?.pending && !config.enabled ? '停止接收本次结果（可能仍计费）' : '暂停后台分析'}</button>
      </div>
    </> : <p>后台付费设置由岗位创建者或企业管理员管理；授权同事可以查看和导入结果。</p>}
  </section>;
}
