/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RecruitmentJobAction, RecruitmentJobHeader, RecruitmentJobResponse, RecruitmentRelatedApplication } from 'otto-server';
import { recruitmentArchiveFingerprint, loadRecruitmentArchive } from '../recruitmentArchive.js';
import type { RecruitmentWorkspaceStore, CandidateWorkspace } from '../recruitmentWorkspaceStore.js';

const STAGES = { new: '待分析', reviewing: '了解中', interview: '面试中', follow_up: '待跟进', closed: '已结束' } as const;
const REASONS = { linked: '已人工关联', contact_pair: '邮箱与手机号均一致，待人工核实', source_record: '材料标注的来源记录一致，待人工核实', conflict: '来源记录一致但联系方式冲突，需核实' } as const;

export function RecruitmentPersonPanel({ store, scopeId, disabled }: { store: RecruitmentWorkspaceStore; scopeId?: string; disabled: boolean }): React.JSX.Element | null {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const candidate = state.candidates.find((item) => item.id === state.activeCandidateId);
  const [jobs, setJobs] = useState<RecruitmentJobHeader[]>([]);
  const [jobCursor, setJobCursor] = useState<string | null>(null);
  const [matches, setMatches] = useState<RecruitmentRelatedApplication[]>([]);
  const [matchCursor, setMatchCursor] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const operation = useRef(new AbortController());
  const running = useRef(false);
  useEffect(() => {
    operation.current = new AbortController(); running.current = false;
    setJobs([]); setMatches([]); setJobCursor(null); setMatchCursor(null); setTargetId(''); setConfirmed(false); setIdentityConfirmed(false); setBusy(false); setMessage(''); setError('');
    return () => operation.current.abort();
  }, [store, scopeId, state.sharedJob?.id, candidate?.id]);
  const dirty = !state.sharedJob?.revision || state.sharedJob.savedFingerprint !== recruitmentArchiveFingerprint(state);
  const locked = busy || disabled || !scopeId || dirty;
  const run = async (task: (call: (action: RecruitmentJobAction) => Promise<RecruitmentJobResponse>, signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (running.current || locked) return;
    const signal = operation.current.signal;
    const before = store.getSnapshot();
    running.current = true; setBusy(true); setMessage(''); setError('');
    const call = async (action: RecruitmentJobAction): Promise<RecruitmentJobResponse> => {
      if (signal.aborted || store.getSnapshot() !== before) throw new Error('工作台已变化，请重新操作');
      if (!scopeId || typeof window.otto.enterpriseRecruitmentJobs !== 'function') throw new Error('请登录企业并升级客户端与服务器');
      const result = await window.otto.enterpriseRecruitmentJobs({ scopeId, action });
      if (signal.aborted || store.getSnapshot() !== before) throw new Error('工作台已变化，返回结果未应用；写入可能已完成，请刷新目标岗位核对');
      return result;
    };
    try { await task(call, signal); } catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : '岗位关联操作失败'); }
    finally { if (!signal.aborted) { running.current = false; setBusy(false); } }
  };
  if (!candidate) return null;
  const refreshJobs = (cursor?: string): Promise<void> => run(async (call) => {
    const result = await call({ kind: 'list', cursor });
    if (result.kind !== 'list') throw new Error('岗位列表格式无效');
    setJobs(result.jobs.filter((job) => job.id !== state.sharedJob?.id)); setJobCursor(result.nextCursor); setTargetId(''); setConfirmed(false);
    setMessage('只列出你有权访问的岗位。新岗位请先在企业共享岗位中创建并保存。');
  });
  const find = (cursor?: string): Promise<void> => run(async (call) => {
    const result = await call({ kind: 'related', jobId: state.sharedJob!.id, candidateId: candidate.id, cursor });
    if (result.kind !== 'related') throw new Error('岗位关联结果格式无效');
    setMatches(result.matches); setMatchCursor(result.nextCursor); setIdentityConfirmed(false);
    setMessage(result.matches.length ? '以下记录仅供身份核对，不会自动合并候选人。各岗位的评价和进展独立。' : result.nextCursor ? '本页没有匹配记录，可继续检查下一页。' : '本页没有匹配记录。不会因同名或单个联系方式一致自动合并。');
  });
  return <section className="otto-recruitment-panel otto-recruitment-archive otto-recruitment-person">
    <label>此岗位进展<select aria-label="此岗位进展" value={candidate.pipelineStage ?? 'new'} disabled={busy || disabled} onChange={(event) => {
      const pipelineStage = event.target.value as CandidateWorkspace['pipelineStage'];
      store.setCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, pipelineStage } : item));
      setMatches([]); setMessage('进展已在本地修改，请保存当前岗位后向同事同步；不会更新外部招聘平台。');
    }}>{Object.entries(STAGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <small>进展由人维护，与分析结果分开；不代表模型录用或淘汰决定。</small>
    <details>
      <summary>关联其他岗位与复用资料</summary>
      <p>当前候选人：{candidate.fileName}。复用材料到另一岗位后，原岗位不变，新岗位重新分析。仅保存现有文本与来源，不会重新调用模型或延长保存期限。</p>
      {dirty ? <p>请先保存当前岗位，再查询或复用服务器中的候选人资料。</p> : null}
      {!scopeId ? <p>登录企业账号后可使用跨岗位关联。</p> : null}
      <div className="otto-recruitment-actions"><button type="button" disabled={locked} onClick={() => void refreshJobs()}>选择目标岗位</button><button type="button" disabled={locked} onClick={() => void find()}>查找已有岗位记录</button></div>
      <label>复用到哪个岗位<select aria-label="复用到哪个岗位" value={targetId} disabled={locked} onChange={(event) => { setTargetId(event.target.value); setConfirmed(false); }}><option value="">请选择目标岗位</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.title} · v{job.revision}</option>)}</select></label>
      {jobCursor ? <button type="button" disabled={locked} onClick={() => void refreshJobs(jobCursor)}>下一页目标岗位</button> : null}
      <label><input type="checkbox" checked={confirmed} disabled={locked} onChange={(event) => setConfirmed(event.target.checked)} />我确认有权向目标岗位的授权同事共享此候选人材料，用于该岗位招聘</label>
      <button type="button" disabled={locked || !confirmed || !targetId} onClick={() => void run(async (call) => {
        const target = jobs.find((job) => job.id === targetId);
        if (!target) throw new Error('请重新选择目标岗位');
        const result = await call({ kind: 'copy_candidate', jobId: state.sharedJob!.id, candidateId: candidate.id, expectedRevision: state.sharedJob!.revision, targetJobId: target.id, targetRevision: target.revision, sharingConfirmed: true });
        if (result.kind !== 'job' || result.job.id !== target.id) throw new Error('目标岗位返回结果无效，请刷新核对');
        setJobs((items) => items.map((item) => item.id === target.id ? result.job : item)); setConfirmed(false); setMatches([]);
        setMessage(`已复用至「${target.title}」，状态为待分析。可在企业共享岗位中加载它；当前工作台未替换。`);
      })}>确认复用到目标岗位</button>
      {matches.length ? <>
        <label><input type="checkbox" checked={identityConfirmed} disabled={locked} onChange={(event) => setIdentityConfirmed(event.target.checked)} />我已核实这是同一人，允许仅关联所选岗位记录（不覆盖双方材料、评价和进展）</label>
        {matches.map((match) => <article key={`${match.jobId}:${match.candidateId}`}>
          <h4>{match.jobTitle} · {STAGES[match.stage]}</h4><p>{match.fileName} · {REASONS[match.reason]}</p>
          <button type="button" disabled={locked} onClick={() => void run(async (call, signal) => {
            await loadRecruitmentArchive(store, call, match.jobId, signal);
            store.setActiveCandidateId(match.candidateId);
          })}>查看此岗位材料</button>
          {match.reason !== 'linked' ? <button type="button" disabled={locked || !identityConfirmed} onClick={() => void run(async (call) => {
            const result = await call({ kind: 'link_candidate', jobId: state.sharedJob!.id, candidateId: candidate.id, expectedRevision: state.sharedJob!.revision, targetJobId: match.jobId, targetCandidateId: match.candidateId, targetRevision: match.jobRevision, sharingConfirmed: true });
            if (result.kind !== 'job') throw new Error('关联返回结果无效');
            setMatches([]); setIdentityConfirmed(false); setMessage('已关联所选档案；没有合并或覆盖岗位材料与评价。如核对有误，可加载该岗位后解除关联。');
          })}>确认关联这份记录</button> : null}
        </article>)}
      </> : null}
      {matchCursor ? <button type="button" disabled={locked} onClick={() => void find(matchCursor)}>继续查找下一页</button> : null}
      <details><summary>关联错人了？</summary><p>解除当前岗位的候选人关联，不删除任何材料。其他岗位的记录不会改变。</p><button type="button" disabled={locked} onClick={() => void run(async (call) => {
        const binding = state.sharedJob!;
        const result = await call({ kind: 'unlink_candidate', jobId: binding.id, candidateId: candidate.id, expectedRevision: binding.revision, confirmed: true });
        if (result.kind !== 'job' || result.job.id !== binding.id) throw new Error('解除关联返回结果无效');
        store.setSharedJob({ ...binding, revision: result.job.revision, base: result.job, sync: result.sync, canManage: result.canManage }); setMatches([]); setMessage('当前岗位关联已解除，材料及原有分析保留。联系方式相同的记录仍可能作为待核对线索出现。');
      })}>确认解除当前岗位关联</button></details>
    </details>
    {busy ? <p role="status">正在核对岗位档案…</p> : null}
    {message ? <p role="status">{message}</p> : null}{error ? <p role="alert">{error}</p> : null}
  </section>;
}
