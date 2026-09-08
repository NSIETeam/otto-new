/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from 'react';
import type { RecruitmentEvidenceGraphNode } from '../../main/recruitmentSemantic.js';
import { createEvidenceReview, evidenceReviewBinding, type RecruitmentEvidenceReview } from '../recruitmentAssessment.js';
import { makeRecruitmentAudit, type CandidateWorkspace, type RecruitmentWorkspaceStore } from '../recruitmentWorkspaceStore.js';

const outcomeLabel = { supported: '核实后支持', contradicted: '核实后不支持', inconclusive: '仍待补证' };
export function RecruitmentEvidenceReviewPanel({ candidate, graph, reviewerId, store, jobTitle, jobDescription }: {
  candidate: CandidateWorkspace; graph: RecruitmentEvidenceGraphNode[]; reviewerId: string; store: RecruitmentWorkspaceStore; jobTitle: string; jobDescription: string;
}) {
  const [checked, setChecked] = useState<{ candidate: CandidateWorkspace; jobTitle: string; jobDescription: string; binding: string } | null>(null);
  const [criterion, setCriterion] = useState(graph[0]?.criterion ?? '');
  const [outcome, setOutcome] = useState<RecruitmentEvidenceReview['outcome']>('inconclusive');
  const [rationale, setRationale] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setConfirmed(false);
    void evidenceReviewBinding(candidate, { jobTitle, jobDescription }).then((binding) => {
      if (active) setChecked({ candidate, jobTitle, jobDescription, binding });
    }).catch(() => { if (active) setError('无法检查材料版本，暂不能记录核实结果'); });
    return () => { active = false; };
  }, [candidate, jobTitle, jobDescription]);
  const binding = checked?.candidate === candidate && checked.jobTitle === jobTitle && checked.jobDescription === jobDescription ? checked.binding : null;
  const stillCurrent = () => {
    const state = store.getSnapshot();
    return state.candidates.find((item) => item.id === candidate.id) === candidate && state.jobTitle === jobTitle && state.jobDescription === jobDescription;
  };
  const save = () => {
    try {
      if (!binding || !stillCurrent() || !graph.some((node) => node.criterion === criterion)) throw new Error('材料或岗位已变化，请重新核实');
      if ((candidate.evidenceReviews?.length ?? 0) >= 100) throw new Error('核实记录已达 100 条，请先整理；本次未覆盖历史记录');
      const review = createEvidenceReview({ binding, criterion, reviewerId, outcome, rationale, confirmed });
      store.setCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, evidenceReviews: [...(item.evidenceReviews ?? []), review] } : item));
      store.setAudits((items) => [...items, makeRecruitmentAudit(candidate.id, 'evidence-human-review', `人工填写逐项核实记录：${criterion}；${outcomeLabel[outcome]}。`, 'human')]);
      setRationale(''); setConfirmed(false); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '记录失败'); }
  };
  return <div className="otto-recruitment-panel">
    <header><div><strong>招聘人员逐项核实</strong><span>与模型判断分开记录，不会改写原文、冲突提示或招聘决定</span></div></header>
    <p>由填写人确认核实方式和依据；这是人工填写记录，不是平台替其认证。材料、岗位或分析更新后，原记录须重新复核。共享仍需在共享档案中保存。</p>
    {(candidate.evidenceReviews ?? []).length === 0 ? <p>尚无人工逐项核实记录。</p> : <ul>{candidate.evidenceReviews?.map((review, index) => <li key={`${review.createdAt}-${index}`}>
      <strong>{review.criterion}：{binding && review.binding === binding ? `人工核实记录 · ${outcomeLabel[review.outcome]}` : '旧核实记录，待重新复核'}</strong>
      <p>{review.rationale}（填写人：{review.reviewerId}，{review.createdAt}）</p>
      {review.reviewerId === reviewerId ? <button type="button" onClick={() => {
        if (!stillCurrent()) return;
        store.setCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, evidenceReviews: item.evidenceReviews?.filter((_, itemIndex) => itemIndex !== index) } : item));
        store.setAudits((items) => [...items, makeRecruitmentAudit(candidate.id, 'evidence-review-withdrawn', `填写人撤销逐项核实记录：${review.criterion}`, 'human')]);
      }}>撤销我的核实记录</button> : null}
    </li>)}</ul>}
    <label>核实的岗位条件<select value={criterion} onChange={(event) => { setCriterion(event.target.value); setConfirmed(false); }}>{[...new Set(graph.map((node) => node.criterion))].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>人工核实结果<select value={outcome} onChange={(event) => { setOutcome(event.target.value as RecruitmentEvidenceReview['outcome']); setConfirmed(false); }}>{Object.entries(outcomeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>核实方式和依据<textarea maxLength={1000} value={rationale} onChange={(event) => { setRationale(event.target.value); setConfirmed(false); }} placeholder="例如：通过现场实战核对了候选人本人实现的测试；仅针对本条岗位条件" /></label>
    <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已人工核实该条件，并对填写的依据负责</label>
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" disabled={!binding || !confirmed || !reviewerId.trim() || !criterion} onClick={save}>保存逐项核实记录</button>
  </div>;
}
