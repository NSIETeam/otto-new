/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useState } from 'react';
import type { RecruitmentAutoArchiveState } from 'otto-server';

export function RecruitmentAutoArchivePanel({ config, canManage, disabled, onConfigure }: {
  config?: RecruitmentAutoArchiveState; canManage: boolean; disabled: boolean;
  onConfigure(enabled: boolean, days?: number): Promise<void>;
}): React.JSX.Element {
  const [confirmed, setConfirmed] = useState(false);
  const [days, setDays] = useState(config?.retentionDays ?? 30);
  useEffect(() => { setConfirmed(false); setDays(config?.retentionDays ?? 30); }, [config?.generation, config?.retentionDays]);
  return <section className="otto-recruitment-panel">
    <h4>后台结果自动入档 · {config?.enabled ? '已开启' : '默认关闭 / 已暂停'}</h4>
    <p>将已完成的后台分析直接保存为本岗位的正式候选人档案，包括当前待处理箱中尚未入档的结果。只保存已有结果，不再次调用模型，不自动淘汰、录用或联系候选人。</p>
    <p>同一来源的新材料可更新未经人工修改的自动档案，并保留历史；已有人工档案、人工修改或分析口径不一致时交给你复核，不凭同名合并。已删除或到期的档案不会自动重建。</p>
    {config ? <p>{config.message} 授权及本窗口新建档案截止：{new Date(config.expiresAt).toLocaleString()}。{config.lastRunAt ? `最近处理：${new Date(config.lastRunAt).toLocaleString()}` : ''}</p> : null}
    {canManage ? <>
      <label>自动入档授权与新档案保存窗口<select aria-label="自动入档授权与新档案保存窗口" disabled={disabled} value={days} onChange={(event) => setDays(Number(event.target.value) as 7 | 30 | 90)}>{[7, 30, 90].map((day) => <option key={day} value={day}>{day} 天</option>)}</select></label>
      <p>从本次确认起计算统一截止日期，越晚新建的档案剩余保存时间越短。到期停止自动入档；更新已有档案不延长其原期限。暂停入档不会同时暂停接收或付费分析。</p>
      <label><input type="checkbox" disabled={disabled} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我授权将已完成的后台结果自动建档或更新，并按当前岗位共享范围与上述期限保存</label>
      <div className="otto-recruitment-actions">
        <button type="button" disabled={disabled || !confirmed} onClick={async () => { await onConfigure(true, days); setConfirmed(false); }}>开启 / 更新自动入档</button>
        <button type="button" disabled={disabled || !config?.enabled} onClick={() => void onConfigure(false)}>暂停自动入档</button>
      </div>
    </> : <p>岗位创建者或企业管理员可以授权自动入档；授权同事可查看结果和复核材料。</p>}
  </section>;
}
