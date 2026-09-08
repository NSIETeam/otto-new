/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useState } from 'react';
import type { CandidateWorkspace } from '../recruitmentWorkspaceStore.js';
import { describeRecruitmentAnalysisChange, recruitmentUsageSummary, retainRecruitmentAnalysisHistory } from '../recruitmentAnalysisHistory.js';
import { evidenceSupportLabel } from '../../main/recruitmentAssessment.js';

const textStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 280, overflow: 'auto' } as const;

export function RecruitmentAnalysisHistoryPanel({ candidate, candidates, onExport, exporting }: { candidate: CandidateWorkspace; candidates: CandidateWorkspace[]; onExport?: () => void; exporting?: boolean }) {
  const [open, setOpen] = useState(false);
  const history = candidate.analysisHistory ?? retainRecruitmentAnalysisHistory(undefined, candidate).analysisHistory ?? [];
  const usage = recruitmentUsageSummary([candidate]);
  const total = recruitmentUsageSummary(candidates);
  const reused = candidate.semanticEvaluation?.execution?.disposition === 'reused';
  return <section className="otto-recruitment-panel" aria-label="分析历史与用量">
    <header><div><strong>分析历史与用量</strong><span>{reused ? '本次复用了已有结果，没有新增模型调用' : `已保留 ${history.length} 个分析版本`}</span></div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起分析历史' : '查看分析历史'}</button></header>
    {candidate.semanticEvaluation?.coordination?.status === 'unconfirmed' ? <p role="status">{candidate.semanticEvaluation.coordination.message}</p> : null}
    {open ? <div>
      <p>当前候选人：{usage.runs} 次已保存的独立分析；已知输入 {usage.inputTokens.toLocaleString()}、输出 {usage.outputTokens.toLocaleString()} Token。{usage.unknownRuns ? `${usage.unknownRuns} 次用量不完整或未知，不计作免费。` : ''}</p>
      <p>当前岗位去重合计：{total.runs} 次独立分析，已知输入 {total.inputTokens.toLocaleString()}、输出 {total.outputTokens.toLocaleString()} Token{total.unknownRuns ? `；${total.unknownRuns} 次用量未知或不完整` : ''}。</p>
      <p>仅统计已保存结果的厂商返回值，同一次调用的复用不重复计数；不含失败、未保存请求及音视频转写费用，也不区分缓存命中价格。实际费用以厂商账单为准。</p>
      <p>相同输入在同账号、本次应用运行的短期缓存内复用。最多保存 20 个分析版本；历史随候选人共享和限期清除。新版本不意味着更准确，旧版分数不与当前岗位直接排名比较。</p>
      {onExport ? <p><button type="button" disabled={exporting} onClick={onExport}>导出完整档案与历史</button> 导出含候选人材料，请妥善保管；导出副本不会随 Otto 档案自动删除。</p> : null}
      {history.map((revision, index) => {
        const evaluation = revision.evaluation; const previous = history[index + 1]?.evaluation;
        const changes = evaluation.evidenceGraph?.flatMap((node) => {
          const old = previous?.evidenceGraph?.find((entry) => entry.criterion === node.criterion);
          return old && old.status !== node.status ? [`${node.criterion}：${evidenceSupportLabel(old.status)} → ${evidenceSupportLabel(node.status)}`] : [];
        }) ?? [];
        return <details key={evaluation.execution?.runId ?? `${evaluation.createdAt}:${index}`}>
          <summary>版本 {history.length - index} · {new Date(evaluation.createdAt).toLocaleString('zh-CN')} · {revision.reuseCount ? `复用 ${revision.reuseCount} 次` : '已保存结果'}</summary>
          <p>重算原因：{describeRecruitmentAnalysisChange(previous, evaluation).join('；')}。</p>
          <p>本版判断：{evaluation.summary}</p>
          {previous ? <p>上一版判断：{previous.summary}</p> : null}
          {changes.length ? <ul>{changes.map((change, i) => <li key={i}>{change}</li>)}</ul> : null}
          <p>规则：{evaluation.analysisVersion}；模型：{evaluation.assessmentContext?.modelId ?? evaluation.modelProvider}；岗位：{revision.jobTitle || '旧记录未注明'}。</p>
          <details><summary>查看本版依据与完整结果</summary>
            <p>岗位要求</p><pre style={textStyle}>{revision.jobDescription || '旧记录未注明'}</pre>
            <p>简历正文（脱敏）</p><pre style={textStyle}>{revision.resumeText || '未提供简历'}</pre>
            <p>面试与实战材料</p><pre style={textStyle}>{[revision.transcriptText, revision.workSampleText].filter(Boolean).join('\n\n') || '本版未提供'}</pre>
            <p>完整分析结果（含原文引用与面试问题）</p><pre style={textStyle}>{JSON.stringify(evaluation, null, 2)}</pre>
          </details>
        </details>;
      })}
      {!history.length ? <p>尚无已完成的分析；材料和失败提示保留在当前档案。</p> : null}
    </div> : null}
  </section>;
}
