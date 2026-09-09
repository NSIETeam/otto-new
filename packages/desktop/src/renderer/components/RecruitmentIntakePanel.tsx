/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RecruitmentIncomingMaterial, RecruitmentJobAction } from 'otto-server';
import type { RecruitmentWorkspaceStore } from '../recruitmentWorkspaceStore.js';
import { updateRecruitmentIntake } from '../recruitmentArchive.js';
import { getRecruitmentAutosave } from '../recruitmentAutosave.js';
import { RecruitmentBackgroundPanel } from './RecruitmentBackgroundPanel.js';
import { RecruitmentAutoArchivePanel } from './RecruitmentAutoArchivePanel.js';
import { RecruitmentOneOffAnalysis } from './RecruitmentOneOffAnalysis.js';

export function RecruitmentIntakePanel({ store, scopeId, disabled, onImport, onViewCandidate }: {
  store: RecruitmentWorkspaceStore; scopeId?: string; disabled: boolean;
  onImport(item: RecruitmentIncomingMaterial): Promise<void>;
  onViewCandidate?(): void;
}): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const autosaveController = getRecruitmentAutosave(store);
  const autosave = useSyncExternalStore(autosaveController.subscribe, autosaveController.getSnapshot, autosaveController.getSnapshot);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false); const [removeId, setRemoveId] = useState('');
  const [resetId, setResetId] = useState('');
  const [interval, setIntervalMinutes] = useState(60); const [retention, setRetention] = useState(7); const [limit, setLimit] = useState(5);
  const controller = useRef(new AbortController());
  const binding = state.sharedJob; const config = binding?.base?.intake;
  const inbox = (binding?.base?.incomingMaterials ?? []).filter((item) => Date.parse(item.expiresAt) > Date.now());
  const epoch = store.getWorkspaceEpoch();
  useEffect(() => {
    controller.current = new AbortController(); setBusy(false); setError(''); setConfirmed(false); setRemoveId('');
    setIntervalMinutes(60); setRetention(7); setLimit(5); setResetId('');
    return () => controller.current.abort();
  }, [scopeId, store, binding?.id, binding?.sync?.scopeToken, epoch]);
  useEffect(() => {
    setIntervalMinutes(config?.intervalMinutes ?? 60); setRetention(config?.retentionDays ?? 7); setLimit(config?.maxMaterials ?? 5);
  }, [config?.generation, config?.intervalMinutes, config?.retentionDays, config?.maxMaterials]);
  const locked = busy || disabled || Boolean(autosave.pending) || !scopeId || !binding?.revision;
  const run = async (action: Extract<RecruitmentJobAction, { kind: 'configure_intake' | 'dismiss_intake' | 'configure_background_analysis' | 'configure_auto_archive' | 'reset_intake_analysis' | 'analyze_intake_once' | 'get' }>): Promise<void> => {
    const signal = controller.current.signal; setBusy(true); setError('');
    try {
      if (!scopeId || typeof window.otto.enterpriseRecruitmentJobs !== 'function') throw new Error('请连接支持后台招聘接收的企业服务器');
      await updateRecruitmentIntake(store, (request) => window.otto.enterpriseRecruitmentJobs({ scopeId, action: request }), action, signal);
      if (!signal.aborted) { setConfirmed(false); setRemoveId(''); setResetId(''); }
    } catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : '后台接收操作未完成，请刷新'); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  return <details className="otto-recruitment-panel">
    <summary>后台接收简历 · {config?.enabled ? '已开启' : '未开启 / 已暂停'} · {inbox.filter((item) => !item.archive || item.archive.status === 'needs_review').length} 份待处理 · {inbox.filter((item) => item.archive?.status === 'needs_review').length} 份需复核</summary>
    <p>服务器按计划读取你在 Workable 本企业人才库中有权访问的材料，关闭 Otto 后仍继续接收。不是全网搜人；接收本身不调用模型，也不联系候选人。付费分析需另行开启。</p>
    {!binding?.revision ? <p>先保存或加载企业共享岗位，再连接 Workable 并完成真实账号验收。</p> : <>
      <button type="button" disabled={locked} onClick={() => void run({ kind: 'get', jobId: binding.id })}>刷新待处理箱</button>
      <RecruitmentBackgroundPanel key={`${binding.id}:${epoch}`} config={binding.base?.backgroundAnalysis} canManage={Boolean(binding.canManage)} disabled={locked}
        onConfigure={(enabled, requests, tokens) => run({ kind: 'configure_background_analysis', jobId: binding.id, expectedRevision: binding.revision, enabled, confirmed: true, dailyRequestLimit: requests, dailyReservedTokenLimit: tokens })} />
      <RecruitmentAutoArchivePanel key={`archive:${binding.id}:${binding.sync?.scopeToken}:${epoch}`} config={binding.base?.autoArchive} canManage={Boolean(binding.canManage)} disabled={locked}
        onConfigure={(enabled, days) => run({ kind: 'configure_auto_archive', jobId: binding.id, expectedRevision: binding.revision, enabled, confirmed: true, ...(enabled ? { retentionDays: days } : {}) })} />
      {binding.canManage ? <>
        <p>开启使用操作者自己的 Workable 授权；资料共享给当前岗位创建者、企业管理员和本岗位授权同事。未通过真实账号验收或授权范围不足时，服务器会拒绝开启。</p>
        <label>接收间隔<select aria-label="接收间隔" disabled={locked} value={interval} onChange={(event) => setIntervalMinutes(Number(event.target.value))}>{[[30, '30 分钟'], [60, '1 小时'], [360, '6 小时'], [1440, '每天']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>待处理保存期限<select aria-label="待处理保存期限" disabled={locked} value={retention} onChange={(event) => setRetention(Number(event.target.value))}>{[7, 30, 90].map((days) => <option key={days} value={days}>{days} 天</option>)}</select></label>
        <label>单次最多读取<select aria-label="单次最多读取" disabled={locked} value={limit} onChange={(event) => setLimit(Number(event.target.value))}>{[5, 10, 20].map((count) => <option key={count} value={count}>{count} 份</option>)}</select></label>
        <label><input type="checkbox" disabled={locked} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我确认有权后台读取、限期保存，并向当前岗位授权同事共享这些材料</label>
        <div className="otto-recruitment-actions">
          <button type="button" disabled={locked || !confirmed} onClick={() => void run({ kind: 'configure_intake', jobId: binding.id, expectedRevision: binding.revision, enabled: true, confirmed: true, intervalMinutes: interval, retentionDays: retention, maxMaterials: limit })}>开启 / 更新后台接收</button>
          <button type="button" disabled={locked || !config?.enabled} onClick={() => void run({ kind: 'configure_intake', jobId: binding.id, expectedRevision: binding.revision, enabled: false, confirmed: true })}>暂停后台接收</button>
        </div>
      </> : <p>你可以处理本岗位材料；开启、暂停任务需岗位创建者或企业管理员操作。</p>}
      {config ? <p>当前设置：每 {config.intervalMinutes} 分钟，最多 {config.maxMaterials} 份，待处理保留 {config.retentionDays} 天。{config.enabled ? `下次计划：${new Date(config.nextRunAt).toLocaleString()}（按服务器排队执行）` : '当前不会继续读取。'}{config.lease ? ' 本轮正在执行；暂停会使晚到结果不再入档。' : ''}</p> : null}
      <p>读取到正文不等于完成分析或验证能力。导入后沿用工作台的分析与保存流程；确认档案保存成功后再移除待处理材料。移除不会删除已导入的候选人档案，同一材料在本次保留期内不会重新加入。</p>
      {inbox.map((item) => <article className="otto-recruitment-panel" key={item.id}>
        <strong>{item.material.material.fileName || '候选人资料'} · {item.material.source.sourceLabel}</strong>
        <p>{item.manualAnalysis ? '同事已认领 · 不会自动重复分析' : item.analysis?.status === 'completed' ? '企业模型已分析 · 简历自述支持，尚未核实能力' : item.analysis ? '已尝试调用 · 结果未知 / 待人工处理' : item.material.material.completeness === 'full_text' ? '已读取正文 · 待全文分析' : '材料不完整 · 尚未全文分析'} · 来源记录 {item.material.source.sourceRecordId}</p>
        <p>接收于 {new Date(item.receivedAt).toLocaleString()} · 待处理期限 {new Date(item.expiresAt).toLocaleString()}</p>
        {item.archive ? <p>{item.archive.status === 'needs_review' ? '需要人工复核' : '已正式入档'}：{item.archive.message} · {new Date(item.archive.at).toLocaleString()}</p> : null}
        {item.archive?.candidateId && state.candidates.some((candidate) => candidate.id === item.archive!.candidateId) ? <button type="button" onClick={() => { store.setActiveCandidateId(item.archive!.candidateId!); onViewCandidate?.(); }}>查看已入档候选人</button> : null}
        {item.analysis ? <p>{item.analysis.message}{item.analysis.evaluation ? `：${item.analysis.evaluation.summary}` : ''}</p> : null}
        {item.analysis?.trigger ? <p>触发方式：{item.analysis.trigger === 'manual' ? '同事单次提交' : '后台计划'}{item.analysis.requestedBy ? ` · 处理账号：${item.analysis.requestedBy}` : ''}</p> : null}
        {!item.analysis && !item.manualAnalysis && item.material.material.completeness === 'full_text' ? <RecruitmentOneOffAnalysis
          modelId={binding.base?.backgroundAnalysis?.modelId} disabled={locked || Boolean(binding.base?.backgroundAnalysis?.pending)} onRun={run}
          savedJob={binding.base ? { title: binding.base.title, description: binding.base.description } : undefined}
          request={binding.sync && binding.base?.backgroundAnalysis?.modelVersion ? { kind: 'analyze_intake_once', jobId: binding.id, itemId: item.id, expectedRevision: binding.revision, scopeToken: binding.sync.scopeToken, headerToken: binding.sync.headerToken, modelVersion: binding.base.backgroundAnalysis.modelVersion, confirmed: true } : undefined} /> : null}
        {item.manualAnalysis ? <>
          <p>处理账号：{item.manualAnalysis.actorAccountId} · {new Date(item.manualAnalysis.createdAt).toLocaleString()}。{item.manualAnalysis.message}</p>
          {item.manualAnalysis.status !== 'completed' && Date.parse(item.manualAnalysis.expiresAt) <= Date.now() ? <p>处理截止时间已过，结果仍待核对；不会自动释放或重新计费。先检查原客户端是否已有结果，并刷新共享档案。</p> : null}
          {binding.canManage ? <details><summary>重新处理这份材料</summary>
            <p>原结果不会被删除。请先核对原客户端、共享保存状态和厂商账单；未完成的请求需等截止时间过后再操作。解除认领后，如果后台分析已开启，服务器可能按现有预算再次分析并产生费用。</p>
            <label><input type="checkbox" disabled={locked} checked={resetId === item.manualAnalysis.id} onChange={(event) => setResetId(event.target.checked ? item.manualAnalysis!.id : '')} />我已核对原客户端与厂商用量，确认重新处理，接受可能再次计费</label>
            <button type="button" disabled={locked || !binding.sync || resetId !== item.manualAnalysis.id || (item.manualAnalysis.status !== 'completed' && Date.parse(item.manualAnalysis.expiresAt) > Date.now())} onClick={() => void run({ kind: 'reset_intake_analysis', jobId: binding.id, itemId: item.id, claimId: item.manualAnalysis!.id, scopeToken: binding.sync!.scopeToken, headerToken: binding.sync!.headerToken, confirmed: true })}>确认重新处理</button>
          </details> : null}
        </> : null}
        {item.manualAnalysisHistory?.length ? <details><summary>此前处理记录（{item.manualAnalysisHistory.length} 次）</summary>{item.manualAnalysisHistory.map((claim) => <p key={claim.id}>{new Date(claim.createdAt).toLocaleString()} · {claim.actorAccountId} · {claim.message}</p>)}</details> : null}
        {item.analysis?.evaluation ? <details><summary>查看后台分析要点（仅岗位与简历，未使用企业记忆）</summary><p>主要优势：{item.analysis.evaluation.strengths.join('；') || '待核实'}</p><p>待核实：{[...item.analysis.evaluation.risks, ...item.analysis.evaluation.missingInformation].join('；') || '请结合面试核实'}</p>{item.analysis.evaluation.dimensions.map((dimension) => <p key={dimension.id}>{dimension.label}：{dimension.assessment}{dimension.evidence.map((evidence) => ` · 简历第 ${evidence.line} 行：“${evidence.quote}”`).join('')}</p>)}</details> : null}
        {!item.archive || item.archive.status === 'needs_review' ? <button type="button" disabled={locked || !state.consentConfirmed || Boolean(item.manualAnalysis) || Boolean(binding.base?.autoArchive?.enabled && !item.archive && item.analysis?.status === 'completed') || binding.base?.backgroundAnalysis?.pending?.itemId === item.id || (!item.analysis && Boolean(binding.base?.backgroundAnalysis?.enabled))} onClick={() => void onImport(item)}>{item.manualAnalysis ? '已由同事认领，请刷新档案' : binding.base?.autoArchive?.enabled && !item.archive && item.analysis?.status === 'completed' ? '等待自动入档，请稍后刷新' : item.analysis?.status === 'completed' ? '导入后台结果（不新增模型调用）' : item.analysis ? '仅导入材料（不自动重试）' : binding.base?.backgroundAnalysis?.enabled ? '等待后台处理，请稍后刷新' : '导入工作台并分析'}</button> : null}
        <label><input type="checkbox" checked={removeId === item.id} onChange={(event) => setRemoveId(event.target.checked ? item.id : '')} />我已确认不再需要此待处理副本</label>
        <button type="button" disabled={locked || removeId !== item.id} onClick={() => void run({ kind: 'dismiss_intake', jobId: binding.id, expectedRevision: binding.revision, itemId: item.id, confirmed: true })}>移除待处理副本</button>
      </article>)}
      {!state.consentConfirmed && inbox.length ? <p>导入前请勾选工作台的候选人分析与限期保存授权。</p> : null}
      {config?.runs.length ? <details><summary>最近运行记录（最多 10 轮）</summary>{config.runs.map((run) => <p key={run.id}>{new Date(run.finishedAt).toLocaleString()} · 新接收 {run.received} / 未变化 {run.unchanged} / 未完整成功 {run.failed}。{run.message}{run.hasMore ? ' 来源仍有下一页。' : ''}</p>)}</details> : null}
    </>}
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
