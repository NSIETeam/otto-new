/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from 'react';
import { assessCandidateComparison, buildCandidateComparisonReport, type RecruitmentComparison } from '../recruitmentAssessment.js';
import { RECRUITMENT_COVERAGE_NOTICE } from '../../main/recruitmentAssessment.js';
import type { CandidateWorkspace } from '../recruitmentWorkspaceStore.js';

export function RecruitmentComparisonPanel({ candidates, jobTitle, jobDescription, exporting, onExport }: {
  candidates: CandidateWorkspace[]; jobTitle: string; jobDescription: string; exporting: boolean; onExport: (report: string) => void;
}) {
  const [excluded, setExcluded] = useState<string[]>([]);
  const [checked, setChecked] = useState<{ candidates: CandidateWorkspace[]; excluded: string[]; jobTitle: string; jobDescription: string; result: RecruitmentComparison | null; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    const snapshot = { candidates, excluded, jobTitle, jobDescription };
    void assessCandidateComparison(candidates.filter((candidate) => !excluded.includes(candidate.id)), { jobTitle, jobDescription })
      .then((result) => { if (active) setChecked({ ...snapshot, result }); })
      .catch(() => { if (active) setChecked({ ...snapshot, result: null, error: '比较口径检查失败，未展示分数。请重试。' }); });
    return () => { active = false; };
  }, [candidates, excluded, jobTitle, jobDescription]);
  // Never render/export a completed check for a previous render's materials.
  const current = checked?.candidates === candidates && checked.excluded === excluded && checked.jobTitle === jobTitle && checked.jobDescription === jobDescription ? checked : null;
  const result = current?.result;
  return <section className="otto-recruitment-panel otto-recruitment-comparison">
    <header><div><strong>候选人横向比较</strong><span>选择同岗位、同材料范围的人选；保持导入顺序，不自动排名</span></div>
      <button type="button" disabled={exporting || !result} onClick={() => { if (result) onExport(buildCandidateComparisonReport(result)); }}>导出</button></header>
    <fieldset><legend>本次比较的人选</legend>{candidates.map((candidate) => <label key={candidate.id} style={{ display: 'inline-flex', gap: 6, marginRight: 16 }}>
      <input type="checkbox" checked={!excluded.includes(candidate.id)} onChange={(event) => setExcluded(event.target.checked ? excluded.filter((id) => id !== candidate.id) : [...excluded, candidate.id])} />{candidate.analysis.identity.name || candidate.fileName}
    </label>)}</fieldset>
    {!current ? <p role="status">正在检查岗位、材料和分析版本…</p> : current.error ? <p role="alert">{current.error}</p> : null}
    {result && !result.comparable ? <div role="status"><strong>暂不比较分数</strong><ul>{result.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div> : null}
    {result?.comparable ? <p>本次分析口径一致。材料类型相同不代表材料质量相同，结论仍须人工核实。</p> : null}
    <p>{RECRUITMENT_COVERAGE_NOTICE}</p>
    {result ? <div><table><thead><tr><th>候选人</th><th>材料范围</th><th>综合匹配度</th><th>核心能力</th><th>经验深度</th><th>交付结果</th><th>引用维度覆盖</th><th>检查结果</th></tr></thead><tbody>
      {result.rows.map(({ candidate, reasons, scope }) => {
        const item = result.comparable ? candidate.semanticEvaluation : null;
        const dimensions = new Map(item?.dimensions.map((dimension) => [dimension.id, dimension.score]));
        return <tr key={candidate.id}><td>{candidate.analysis.identity.name || candidate.fileName}</td><td>{scope}</td><td>{item?.overallScore ?? '—'}</td><td>{dimensions.get('core_capability') ?? '—'}</td><td>{dimensions.get('experience_depth') ?? '—'}</td><td>{dimensions.get('delivery_impact') ?? '—'}</td><td>{item ? `${item.evidenceCoverage}%` : '—'}</td><td>{reasons.join('；') || (result.comparable ? '口径一致，仍须核实' : '本组暂不比较分数')}</td></tr>;
      })}
    </tbody></table></div> : null}
  </section>;
}
