/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PolicyEnterpriseProfile,
  PolicyIntelligenceState,
} from '../../preload/index.js';
import { DialogFrame } from './WorkspaceDialogs.js';

const EMPTY_STATE: PolicyIntelligenceState = {
  enabled: false, profile: {}, policies: [], assessments: [], syncStatus: 'idle',
};

function toNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function dateText(value?: string): string {
  if (!value) return '日期未识别';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN');
}

const STATUS_LABEL: Record<string, string> = {
  likely_eligible: '初步符合', has_gaps: '存在缺口', unlikely: '初步不符合', unknown: '资料不足',
};

export function PolicyIntelligenceDialog({
  open, scopeId, seedProfile, onClose,
}: {
  open: boolean;
  scopeId: string;
  seedProfile: PolicyEnterpriseProfile;
  onClose(): void;
}): React.JSX.Element | null {
  const [state, setState] = useState<PolicyIntelligenceState>(EMPTY_STATE);
  const [profile, setProfile] = useState<PolicyEnterpriseProfile>(seedProfile);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const epochRef = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    setLoading(true); setError('');
    try {
      const loaded = await window.otto.policyIntelligenceGet(scopeId);
      if (epoch !== epochRef.current) return;
      setState(loaded);
      setProfile({ ...seedProfile, ...loaded.profile });
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch === epochRef.current) setLoading(false);
    }
  }, [scopeId, seedProfile]);
  useEffect(() => {
    if (!open) { epochRef.current += 1; return; }
    void refresh();
  }, [open, refresh]);
  const documents = useMemo(() => new Map(state.policies.map((item) => [item.id, item])), [state.policies]);
  const ranked = useMemo(() => [...state.assessments].sort((left, right) => right.score - left.score), [state.assessments]);
  const toggleEnabled = async (): Promise<void> => {
    const enabled = !state.enabled;
    setLoading(true); setError('');
    try {
      let next = await window.otto.policyIntelligenceConfigure({ scopeId, enabled, profile: { ...seedProfile, ...profile } });
      if (enabled) next = await window.otto.policyIntelligenceSync({ scopeId, reason: 'manual' });
      setState(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const saveProfile = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setLoading(true); setError('');
    try {
      await window.otto.policyIntelligenceUpdateProfile({ scopeId, patch: profile });
      const next = state.enabled
        ? await window.otto.policyIntelligenceSync({ scopeId, reason: 'profile_update' })
        : await window.otto.policyIntelligenceGet(scopeId);
      setState(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const manualSync = async (): Promise<void> => {
    setLoading(true); setError('');
    try { setState(await window.otto.policyIntelligenceSync({ scopeId, reason: 'manual' })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  if (!open) return null;
  return <DialogFrame title="政策智能服务" onClose={onClose}>
    <section className="otto-policy-intelligence__status">
      <div><strong>{state.enabled ? '已开启' : '未开启'}</strong><span>{state.enabled ? '启动与退出时增量读取官方政策；只有内容或企业资料变化时才分析。' : '关闭状态不访问政策网站、不调用模型，也不消耗 Token。'}</span></div>
      <button type="button" className={state.enabled ? 'is-on' : ''} disabled={loading} aria-pressed={state.enabled} onClick={() => void toggleEnabled()}>{state.enabled ? '关闭服务' : '开启服务'}</button>
    </section>
    <form className="otto-workspace-dialog__editor otto-policy-intelligence__profile" onSubmit={(event) => void saveProfile(event)}>
      <h3>企业申报画像</h3><p>这些资料只用于政策匹配。对话中补充的内容也会先让你确认，再写入同一份画像。</p>
      <label><span>企业名称</span><input value={profile.organizationName ?? ''} onChange={(event) => setProfile({ ...profile, organizationName: event.target.value })}/></label>
      <label><span>注册地区 *</span><input value={profile.registeredRegion ?? ''} placeholder="例如：北京市昌平区" onChange={(event) => setProfile({ ...profile, registeredRegion: event.target.value })}/></label>
      <label><span>主营行业 *</span><input value={profile.industry ?? ''} placeholder="例如：软件与信息技术服务" onChange={(event) => setProfile({ ...profile, industry: event.target.value })}/></label>
      <label><span>成立时间</span><input value={profile.establishedAt ?? ''} placeholder="YYYY-MM-DD" onChange={(event) => setProfile({ ...profile, establishedAt: event.target.value })}/></label>
      <label><span>员工人数</span><input type="number" min="0" value={profile.employeeCount ?? ''} onChange={(event) => setProfile({ ...profile, employeeCount: toNumber(event.target.value) })}/></label>
      <label><span>年营业收入（元）</span><input type="number" min="0" value={profile.annualRevenueCny ?? ''} onChange={(event) => setProfile({ ...profile, annualRevenueCny: toNumber(event.target.value) })}/></label>
      <label><span>研发费用（元）</span><input type="number" min="0" value={profile.rdExpenseCny ?? ''} onChange={(event) => setProfile({ ...profile, rdExpenseCny: toNumber(event.target.value) })}/></label>
      <label className="is-wide"><span>已有资质</span><input value={profile.qualifications?.join('、') ?? ''} placeholder="例如：高新技术企业、专精特新中小企业" onChange={(event) => setProfile({ ...profile, qualifications: event.target.value.split(/[、，,]/u).map((item) => item.trim()).filter(Boolean) })}/></label>
      <div><button type="submit" disabled={loading}>{loading ? '处理中…' : '保存并重新评估'}</button></div>
    </form>
    <div className="otto-workspace-dialog__toolbar">
      <p>{state.lastSyncAt ? `最近同步：${dateText(state.lastSyncAt)} · 共 ${state.policies.length} 条官方政策` : '尚未同步官方政策'}</p>
      <button type="button" disabled={!state.enabled || loading} onClick={() => void manualSync()}>{loading ? '同步中…' : '立即同步'}</button>
    </div>
    {error || state.lastError ? <p role="alert" className="otto-workspace-dialog__error">{error || state.lastError}</p> : null}
    <div className="otto-workspace-dialog__list otto-policy-intelligence__list">
      {ranked.map((assessment) => {
        const document = documents.get(assessment.policyId);
        if (!document) return null;
        return <article key={assessment.policyId}>
          <div><span>{document.sourceName}</span><span>{STATUS_LABEL[assessment.status]}</span><strong>{assessment.score} 分</strong>{document.deadline ? <span>截止 {dateText(document.deadline)}</span> : null}</div>
          <h3>{document.title}</h3><p>{assessment.summary}</p>
          {assessment.conditions.length ? <ul>{assessment.conditions.map((condition) => <li key={`${condition.label}:${condition.result}`}><strong>{condition.result === 'met' ? '已满足' : condition.result === 'gap' ? '有差距' : '待确认'}：</strong>{condition.label}<small>{condition.evidence}</small></li>)}</ul> : null}
          {assessment.gaps.length ? <p><strong>当前缺口：</strong>{assessment.gaps.join('；')}</p> : null}
          {assessment.missingFields.length ? <p><strong>需补资料：</strong>{assessment.missingFields.join('、')}</p> : null}
          {assessment.resourceConnections.length ? <p><strong>资源对接：</strong>{assessment.resourceConnections.join('；')}</p> : null}
          <footer><small>发布 {dateText(document.publishedAt)} · 分析 {dateText(assessment.assessedAt)}</small><button type="button" onClick={() => void window.otto.openExternal(document.url)}>查看官方原文</button></footer>
        </article>;
      })}
      {!loading && state.enabled && ranked.length === 0 ? <p>暂无已分析政策。请完善注册地区和主营行业后重新同步。</p> : null}
      {!state.enabled ? <p>开启后才会显示政策匹配结果。</p> : null}
    </div>
    <p className="otto-policy-intelligence__notice">Otto 的匹配、差距和可申报判断仅作辅助参考；申报资格、材料和结果以政策原文及主管部门审核为准。</p>
  </DialogFrame>;
}
