/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { RecruitmentModuleTarget } from '../moduleCatalog.js';
import {
  RECRUITMENT_ANALYSIS_VERSION,
  analyzeCandidateResume,
  analyzeInterviewTranscript,
  buildCandidateComparisonReport,
  buildInterviewRecord,
  createHumanHiringDecision,
  generateInterviewKit,
  type CandidateResumeAnalysis,
  type HiringDecisionAudit,
} from '../recruitmentAnalysis.js';
import {
  makeRecruitmentAudit,
  type CandidateWorkspace,
  type RecruitmentAuditEvent,
  type RecruitmentWorkspaceStore,
} from '../recruitmentWorkspaceStore.js';
import {
  RECRUITMENT_SEMANTIC_ANALYSIS_VERSION,
  type RecruitmentHardRequirement,
  type RecruitmentMatchLevel,
} from '../../main/recruitmentSemantic.js';

const TARGET_LABELS: Readonly<Record<RecruitmentModuleTarget, string>> = {
  'resume-analysis': '批量简历',
  'candidate-screening': '综合评估',
  'interview-audio': '音频面试分析',
  'interview-kit': '面试材料',
  'privacy-audit': '隐私与审计',
};

const RESUME_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md', 'markdown']);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm', 'mp4', 'mov']);

function extension(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
}

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remaining = safe % 60;
  return hours > 0
    ? [hours, minutes, remaining].map((value) => String(value).padStart(2, '0')).join(':')
    : [minutes, remaining].map((value) => String(value).padStart(2, '0')).join(':');
}

function makeAudit(
  candidateId: string,
  action: string,
  detail: string,
  actorType: RecruitmentAuditEvent['actorType'] = 'system',
  modelVersion: string | null = RECRUITMENT_ANALYSIS_VERSION,
): RecruitmentAuditEvent {
  return makeRecruitmentAudit(candidateId, action, detail, actorType, modelVersion);
}

function findingStatusLabel(status: CandidateResumeAnalysis['findings'][number]['status']): string {
  if (status === 'supported') return '有直接证据';
  if (status === 'uncertain') return '证据不足';
  return '未找到证据';
}

function matchLevelLabel(level: RecruitmentMatchLevel): string {
  if (level === 'strong') return '高度贴合';
  if (level === 'good') return '较为贴合';
  if (level === 'partial') return '部分贴合';
  if (level === 'weak') return '贴合较弱';
  return '材料不足';
}

function hardRequirementLabel(status: RecruitmentHardRequirement['status']): string {
  if (status === 'met') return '已有充分证据';
  if (status === 'partially_met') return '部分证明';
  if (status === 'not_met') return '原文明示不满足';
  if (status === 'not_demonstrated') return '全文尚未证明';
  return '需要核实';
}

export function RecruitmentWorkbenchDialog({
  open,
  target,
  reviewerId,
  organizationName,
  workspaceStore,
  onClose,
}: {
  open: boolean;
  target: RecruitmentModuleTarget;
  reviewerId: string;
  organizationName: string;
  workspaceStore: RecruitmentWorkspaceStore;
  onClose(): void;
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [activeTarget, setActiveTarget] = useState<RecruitmentModuleTarget>(target);
  const workspace = useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
    workspaceStore.getSnapshot,
  );
  const {
    jobTitle,
    jobDescription,
    consentConfirmed,
    retentionDays,
    candidates,
    activeCandidateId,
    audits,
  } = workspace;
  const setJobTitle = (value: React.SetStateAction<string>): void => workspaceStore.setJobTitle(value);
  const setJobDescription = (value: React.SetStateAction<string>): void => workspaceStore.setJobDescription(value);
  const setConsentConfirmed = (value: React.SetStateAction<boolean>): void => workspaceStore.setConsentConfirmed(value);
  const setRetentionDays = (value: React.SetStateAction<number>): void => workspaceStore.setRetentionDays(value);
  const setCandidates = (value: React.SetStateAction<CandidateWorkspace[]>): void => workspaceStore.setCandidates(value);
  const setActiveCandidateId = (value: React.SetStateAction<string>): void => workspaceStore.setActiveCandidateId(value);
  const setAudits = (value: React.SetStateAction<RecruitmentAuditEvent[]>): void => workspaceStore.setAudits(value);
  const [busy, setBusy] = useState<'resume' | 'reanalyze' | 'audio' | 'export' | ''>('');
  const [resumeProgress, setResumeProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [decision, setDecision] = useState<HiringDecisionAudit['decision']>('hold');
  const [decisionRationale, setDecisionRationale] = useState('');
  const [decisionConfirmed, setDecisionConfirmed] = useState(false);
  const [interviewNotes, setInterviewNotes] = useState('');

  const activeCandidate = candidates.find((candidate) => candidate.id === activeCandidateId) ?? null;
  const interviewKit = useMemo(
    () => activeCandidate
      ? generateInterviewKit(activeCandidate.analysis, activeCandidate.semanticEvaluation)
      : null,
    [activeCandidate],
  );

  useEffect(() => {
    if (!open) return;
    setActiveTarget(target);
    closeRef.current?.focus();
  }, [open, target]);

  useEffect(() => {
    if (!open || candidates.length === 0) return;
    const timer = window.setInterval(() => {
      workspaceStore.purgeExpired(Date.now());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [candidates, open, workspaceStore]);

  if (!open) return null;

  const updateCandidate = (candidateId: string, update: (candidate: CandidateWorkspace) => CandidateWorkspace): void => {
    setCandidates((current) => current.map((candidate) => (
      candidate.id === candidateId ? update(candidate) : candidate
    )));
  };

  const addAudit = (event: RecruitmentAuditEvent): void => {
    setAudits((current) => [event, ...current]);
  };

  const importResume = async (): Promise<void> => {
    setError(''); setNotice('');
    if (!jobTitle.trim() || !jobDescription.trim()) {
      setError('请先填写岗位名称和岗位要求，再导入简历。');
      return;
    }
    if (!consentConfirmed) {
      setError('请先确认已取得候选人对招聘分析和限定期限保存的授权。');
      return;
    }
    setBusy('resume');
    setResumeProgress('');
    try {
      const filePaths = (await window.otto.selectFiles()).slice(0, 20);
      if (!filePaths.length) return;
      const imported: CandidateWorkspace[] = [];
      let failed = 0;
      for (let index = 0; index < filePaths.length; index += 1) {
        const filePath = filePaths[index];
        setResumeProgress(`正在读取并进行全文分析 ${index + 1}/${filePaths.length}`);
        if (!RESUME_EXTENSIONS.has(extension(filePath))) {
          failed += 1;
          continue;
        }
        try {
          const extracted = await window.otto.extractEditableDocument(filePath);
          if (!extracted.content.trim()) throw new Error('简历中没有提取到可分析文字');
          const candidateId = `candidate:${crypto.randomUUID()}`;
          const consentAt = new Date().toISOString();
          const expiresAt = new Date(Date.now() + retentionDays * 86_400_000).toISOString();
          const analysis = analyzeCandidateResume({
            candidateId,
            resumeText: extracted.content,
            jobDescription,
          });
          let semanticEvaluation: CandidateWorkspace['semanticEvaluation'] = null;
          let semanticError = '';
          try {
            semanticEvaluation = await window.otto.recruitmentAnalyzeResume({
              candidateId,
              jobTitle,
              jobDescription,
              redactedResume: analysis.redactedResume,
            });
          } catch (cause) {
            semanticError = cause instanceof Error ? cause.message : String(cause);
          }
          imported.push({
            id: candidateId,
            fileName: extracted.fileName,
            consentAt,
            retentionDays,
            expiresAt,
            analysis,
            semanticEvaluation,
            semanticError,
            jobTitleSnapshot: jobTitle,
            jobDescriptionSnapshot: jobDescription,
            transcriptText: '',
            transcriptReport: null,
            transcriptWarning: '',
            decision: null,
          });
          addAudit(makeAudit(
            candidateId,
            semanticEvaluation ? 'resume_semantic_analyzed' : 'resume_semantic_failed',
            semanticEvaluation
              ? `模型已阅读脱敏简历全文；材料匹配度 ${semanticEvaluation.overallScore}，证据覆盖 ${semanticEvaluation.evidenceCoverage}%。`
              : `简历已脱敏并提取，但模型分析失败：${semanticError}`,
            'system',
            semanticEvaluation
              ? `${semanticEvaluation.analysisVersion}/${semanticEvaluation.modelProvider}`
              : null,
          ));
        } catch {
          failed += 1;
        }
      }
      if (!imported.length) throw new Error('所选文件均未能提取出可分析的简历正文');
      setCandidates((current) => [...current, ...imported]);
      setActiveCandidateId(imported[0].id);
      setConsentConfirmed(false);
      const analyzed = imported.filter((candidate) => candidate.semanticEvaluation).length;
      const modelFailed = imported.length - analyzed;
      setNotice(
        `已导入 ${imported.length} 份简历，${analyzed} 份完成全文智能分析`
        + `${modelFailed ? `，${modelFailed} 份可稍后重试` : ''}`
        + `${failed ? `；另有 ${failed} 个文件未能读取` : ''}。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
      setResumeProgress('');
    }
  };

  const reanalyzeCandidate = async (): Promise<void> => {
    if (!activeCandidate || busy) return;
    setBusy('reanalyze'); setError(''); setNotice('');
    try {
      const semanticEvaluation = await window.otto.recruitmentAnalyzeResume({
        candidateId: activeCandidate.id,
        jobTitle,
        jobDescription,
        redactedResume: activeCandidate.analysis.redactedResume,
      });
      updateCandidate(activeCandidate.id, (candidate) => ({
        ...candidate,
        semanticEvaluation,
        semanticError: '',
        jobTitleSnapshot: jobTitle,
        jobDescriptionSnapshot: jobDescription,
      }));
      addAudit(makeAudit(
        activeCandidate.id,
        'resume_semantic_reanalyzed',
        `按当前岗位说明重新执行全文语义分析；材料匹配度 ${semanticEvaluation.overallScore}，证据覆盖 ${semanticEvaluation.evidenceCoverage}%。`,
        'system',
        `${semanticEvaluation.analysisVersion}/${semanticEvaluation.modelProvider}`,
      ));
      setNotice('已按当前岗位说明重新完成全文智能分析。');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      updateCandidate(activeCandidate.id, (candidate) => ({ ...candidate, semanticError: message }));
      setError(`全文智能分析失败：${message}`);
    } finally {
      setBusy('');
    }
  };

  const transcribeAudio = async (): Promise<void> => {
    if (!activeCandidate) { setError('请先选择并完成一份候选人简历分析。'); return; }
    setBusy('audio'); setError(''); setNotice('');
    try {
      const [filePath] = await window.otto.selectFiles();
      if (!filePath) return;
      if (!AUDIO_EXTENSIONS.has(extension(filePath))) {
        throw new Error('请选择受支持的面试录音或视频文件');
      }
      const result = await window.otto.recruitmentTranscribe(filePath);
      const transcriptText = result.segments.map((segment) => (
        `[${formatTimestamp(segment.startSeconds)}] ${segment.speaker}：${segment.text}`
      )).join('\n');
      const transcriptReport = analyzeInterviewTranscript({
        transcript: transcriptText,
        redactedResume: activeCandidate.analysis.redactedResume,
        jobDescription,
      });
      updateCandidate(activeCandidate.id, (candidate) => ({
        ...candidate,
        transcriptText,
        transcriptReport,
        transcriptWarning: result.warning ?? '',
      }));
      addAudit(makeAudit(activeCandidate.id, 'interview_transcribed',
        `WhisperX 转写完成，共 ${result.segments.length} 段；说话人${result.diarized ? '已自动区分' : '待人工确认'}。`,
        'system', `whisperx/${result.model}`));
      setNotice('面试转写与内容分析完成。分析未使用口音、音高、表情或情绪特征。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  const analyzeEditedTranscript = (): void => {
    if (!activeCandidate || !activeCandidate.transcriptText.trim()) return;
    const transcriptReport = analyzeInterviewTranscript({
      transcript: activeCandidate.transcriptText,
      redactedResume: activeCandidate.analysis.redactedResume,
      jobDescription,
    });
    updateCandidate(activeCandidate.id, (candidate) => ({ ...candidate, transcriptReport }));
    addAudit(makeAudit(activeCandidate.id, 'transcript_reviewed', '招聘人员修订转写文本后重新执行内容分析。', 'human'));
    setNotice('已按修订后的转写重新分析。');
  };

  const saveDecision = (): void => {
    if (!activeCandidate) return;
    setError('');
    try {
      const result = createHumanHiringDecision({
        candidateId: activeCandidate.id,
        reviewerId,
        decision,
        rationale: decisionRationale,
        confirmed: decisionConfirmed,
      });
      updateCandidate(activeCandidate.id, (candidate) => ({ ...candidate, decision: result }));
      addAudit({
        id: result.id,
        candidateId: result.candidateId,
        action: 'human_hiring_decision',
        actorType: 'human',
        modelVersion: null,
        detail: `${result.decision}：${result.rationale}`,
        createdAt: result.createdAt,
      });
      setDecisionRationale(''); setDecisionConfirmed(false);
      setNotice('人工决定已记录。该决定不是模型自动生成。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportText = async (fileName: string, content: string, detail: string): Promise<void> => {
    setBusy('export'); setError('');
    try {
      const saved = await window.otto.saveTextFile(fileName, content);
      if (!saved) return;
      if (activeCandidate) addAudit(makeAudit(activeCandidate.id, 'report_exported', detail, 'human'));
      setNotice(`已导出：${saved}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(''); }
  };

  const purgeCandidate = (candidate: CandidateWorkspace): void => {
    setCandidates((current) => current.filter((item) => item.id !== candidate.id));
    setActiveCandidateId((current) => current === candidate.id ? '' : current);
    addAudit(makeAudit(candidate.id, 'candidate_purged', '招聘人员主动清除候选人简历、转写和分析结果。', 'human', null));
    setNotice('候选人材料已从当前工作台清除；仅保留不含原始材料的审计事件。');
  };

  const renderEmpty = (message: string): React.JSX.Element => (
    <div className="otto-recruitment-empty"><strong>尚无候选人材料</strong><p>{message}</p><button type="button" onClick={() => setActiveTarget('resume-analysis')}>前往简历分析</button></div>
  );

  return createPortal(
    <div className="otto-workspace-dialog-overlay otto-recruitment-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="otto-workspace-dialog otto-recruitment" role="dialog" aria-modal="true" aria-label="智能招聘">
        <header>
          <div><h2>智能招聘</h2><p>{organizationName} · 证据优先，人工决策</p></div>
          <button ref={closeRef} type="button" aria-label="关闭智能招聘" onClick={onClose}>×</button>
        </header>
        <div className="otto-recruitment__shell">
          <nav className="otto-recruitment__tabs" aria-label="智能招聘功能">
            {(Object.keys(TARGET_LABELS) as RecruitmentModuleTarget[]).map((item) => (
              <button key={item} type="button" className={activeTarget === item ? 'is-active' : ''} aria-current={activeTarget === item ? 'page' : undefined} onClick={() => { setActiveTarget(item); setError(''); setNotice(''); }}>
                {TARGET_LABELS[item]}
              </button>
            ))}
          </nav>
          <div className="otto-recruitment__workspace">
            <aside className="otto-recruitment__candidates" aria-label="候选人">
              <div><strong>候选人</strong><span>{candidates.length}</span></div>
              {candidates.map((candidate) => (
                <button key={candidate.id} type="button" className={candidate.id === activeCandidateId ? 'is-active' : ''} onClick={() => setActiveCandidateId(candidate.id)}>
                  <span><strong>{candidate.analysis.identity.name || '候选人（身份已隔离）'}</strong>{candidate.semanticEvaluation ? <b>{candidate.semanticEvaluation.overallScore}</b> : <b className="is-pending">待分析</b>}</span>
                  <small>{candidate.fileName}</small>
                </button>
              ))}
              {candidates.length === 0 ? <p>导入简历后在此切换候选人。</p> : null}
            </aside>
            <main className="otto-recruitment__main">
              <div className="otto-recruitment__page-head">
                <div><span>OTTO OFFICIAL</span><h3>{TARGET_LABELS[activeTarget]}</h3></div>
                <small>全文语义引擎 {RECRUITMENT_SEMANTIC_ANALYSIS_VERSION}</small>
              </div>

              {activeTarget === 'resume-analysis' ? <>
                <section className="otto-recruitment-card otto-recruitment-setup">
                  <div className="otto-recruitment-fields">
                    <label><span>岗位名称</span><input aria-label="岗位名称" value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} placeholder="例如：高级前端工程师" /></label>
                    <label className="is-wide"><span>岗位职责与要求</span><textarea aria-label="岗位要求" rows={8} value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="粘贴完整 JD，包括业务背景、主要职责、必须条件和加分项。Otto 会结合简历全文分析同义经验、实际职责、项目深度和可迁移能力。" /></label>
                    <label><span>材料保存期限</span><select aria-label="材料保存期限" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></label>
                  </div>
                  <label className="otto-recruitment-consent"><input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} /><span>已取得候选人（本批次全部人员）对招聘分析及限定期限保存材料的授权</span></label>
                  <div className="otto-recruitment-import-note"><strong>全文智能分析</strong><span>可一次选择最多 20 份简历。身份字段先在本地隔离，再把脱敏全文交给当前模型综合分析；不会按关键词出现次数打分。</span></div>
                  <div className="otto-recruitment-actions"><button type="button" className="is-primary" disabled={busy === 'resume'} onClick={() => void importResume()}>{busy === 'resume' ? (resumeProgress || '全文分析中…') : '批量导入并智能分析简历'}</button></div>
                </section>
                {activeCandidate ? <section className="otto-recruitment-card otto-recruitment-material-overview">
                  <header><div><strong>{activeCandidate.analysis.identity.name || '候选人'}</strong><span>身份信息已与模型评价输入隔离</span></div><span>{activeCandidate.analysis.timeline.length} 段时间线 · {activeCandidate.analysis.projects.length} 条项目材料</span></header>
                  {activeCandidate.semanticEvaluation ? <div className="otto-recruitment-inline-assessment"><b>{activeCandidate.semanticEvaluation.overallScore}</b><div><strong>{matchLevelLabel(activeCandidate.semanticEvaluation.matchLevel)}</strong><p>{activeCandidate.semanticEvaluation.summary}</p></div><button type="button" disabled={busy === 'reanalyze'} onClick={() => void reanalyzeCandidate()}>{busy === 'reanalyze' ? '分析中…' : '重新分析'}</button></div> : <div className="otto-recruitment-analysis-failed"><strong>尚未获得模型分析</strong><p>{activeCandidate.semanticError || '当前模型没有返回可验证的结构化结果。'}</p><button type="button" disabled={busy === 'reanalyze'} onClick={() => void reanalyzeCandidate()}>{busy === 'reanalyze' ? '分析中…' : '重试全文分析'}</button></div>}
                  {(activeCandidate.jobTitleSnapshot !== jobTitle || activeCandidate.jobDescriptionSnapshot !== jobDescription) ? <p className="otto-recruitment-warning">岗位说明已变化，当前结果仍对应导入时的岗位版本。请重新分析后再比较。</p> : null}
                </section> : null}
              </> : null}

              {activeTarget === 'candidate-screening' ? activeCandidate ? <>
                <div className="otto-recruitment-safety"><strong>全文综合判断</strong><span>模型阅读完整脱敏材料，结合职责、深度、结果和可迁移能力分析。匹配度不是录用概率，不会触发自动淘汰。</span></div>
                {activeCandidate.semanticEvaluation ? <>
                  <section className="otto-recruitment-semantic-hero">
                    <div className="otto-recruitment-score"><strong>{activeCandidate.semanticEvaluation.overallScore}</strong><span>材料匹配度</span><small>{matchLevelLabel(activeCandidate.semanticEvaluation.matchLevel)}</small></div>
                    <div><header><strong>综合结论</strong><span>证据覆盖 {activeCandidate.semanticEvaluation.evidenceCoverage}%</span></header><p>{activeCandidate.semanticEvaluation.summary}</p><small>{activeCandidate.semanticEvaluation.modelProvider} · {activeCandidate.semanticEvaluation.analysisVersion}</small></div>
                  </section>
                  <section className="otto-recruitment-dimensions" aria-label="全文语义分析维度">
                    {activeCandidate.semanticEvaluation.dimensions.map((dimension) => <article key={dimension.id}>
                      <header><div><strong>{dimension.label}</strong><span>{dimension.assessment}</span></div><b>{dimension.score}</b></header>
                      <div className="otto-recruitment-meter"><i style={{ width: `${dimension.score}%` }} /></div>
                      {dimension.evidence.length ? <blockquote>{dimension.evidence.map((evidence) => <span key={`${evidence.line}-${evidence.quote}`}>第 {evidence.line} 行：{evidence.quote}</span>)}</blockquote> : <p className="otto-recruitment-no-evidence">没有可回查的原文证据，本维度分数已受限。</p>}
                      {dimension.uncertainties.length ? <ul>{dimension.uncertainties.map((item) => <li key={item}>待核实：{item}</li>)}</ul> : null}
                    </article>)}
                  </section>
                  <section className="otto-recruitment-insight-grid">
                    <article><header><strong>主要优势</strong><span>{activeCandidate.semanticEvaluation.strengths.length}</span></header><ul>{activeCandidate.semanticEvaluation.strengths.map((item) => <li key={item}>{item}</li>)}</ul></article>
                    <article><header><strong>风险与边界</strong><span>{activeCandidate.semanticEvaluation.risks.length}</span></header><ul>{activeCandidate.semanticEvaluation.risks.map((item) => <li key={item}>{item}</li>)}</ul></article>
                    <article><header><strong>需要补充的信息</strong><span>{activeCandidate.semanticEvaluation.missingInformation.length}</span></header><ul>{activeCandidate.semanticEvaluation.missingInformation.map((item) => <li key={item}>{item}</li>)}</ul></article>
                  </section>
                  <section className="otto-recruitment-card">
                    <header><div><strong>硬性条件核实</strong><span>与综合匹配度分开显示；“全文尚未证明”不等于候选人不具备</span></div></header>
                    <div className="otto-recruitment-hard-requirements">{activeCandidate.semanticEvaluation.hardRequirements.map((requirement, index) => <article key={`${requirement.requirement}-${index}`} className={`is-${requirement.status}`}><header><strong>{requirement.requirement}</strong><b>{hardRequirementLabel(requirement.status)}</b></header><p>{requirement.explanation}</p>{requirement.evidence.length ? <blockquote>{requirement.evidence.map((evidence) => <span key={`${evidence.line}-${evidence.quote}`}>第 {evidence.line} 行：{evidence.quote}</span>)}</blockquote> : null}</article>)}</div>
                  </section>
                </> : <section className="otto-recruitment-analysis-failed"><strong>全文智能分析尚未完成</strong><p>{activeCandidate.semanticError || '没有可展示的模型结果，系统不会退回关键词命中评分。'}</p><button type="button" disabled={busy === 'reanalyze'} onClick={() => void reanalyzeCandidate()}>{busy === 'reanalyze' ? '分析中…' : '重试全文分析'}</button></section>}
                {candidates.length > 1 ? <section className="otto-recruitment-card otto-recruitment-comparison">
                  <header><div><strong>候选人横向对比</strong><span>保持导入顺序，不自动排名</span></div><span>{candidates.length} 人</span></header>
                  <div><table><thead><tr><th>候选人</th><th>综合</th><th>核心能力</th><th>经验深度</th><th>交付结果</th><th>证据覆盖</th></tr></thead><tbody>{candidates.map((candidate) => { const evaluation = candidate.semanticEvaluation; const dimensions = new Map(evaluation?.dimensions.map((item) => [item.id, item.score]) ?? []); return <tr key={candidate.id}><td>{candidate.analysis.identity.name || candidate.fileName}</td><td>{evaluation?.overallScore ?? '待分析'}</td><td>{dimensions.get('core_capability') ?? '—'}</td><td>{dimensions.get('experience_depth') ?? '—'}</td><td>{dimensions.get('delivery_impact') ?? '—'}</td><td>{evaluation ? `${evaluation.evidenceCoverage}%` : '—'}</td></tr>; })}</tbody></table></div>
                </section> : null}
                <section className="otto-recruitment-card otto-recruitment-decision">
                  <header><div><strong>招聘人员最终决定</strong><span>模型无权在此提交决定</span></div>{activeCandidate.decision ? <b>已记录：{activeCandidate.decision.decision}</b> : null}</header>
                  <div><select aria-label="人工决定" value={decision} onChange={(event) => setDecision(event.target.value as HiringDecisionAudit['decision'])}><option value="shortlist">进入下一轮</option><option value="hold">待补充材料</option><option value="reject">人工淘汰</option></select><textarea aria-label="人工判断依据" rows={3} value={decisionRationale} onChange={(event) => setDecisionRationale(event.target.value)} placeholder="写明依据的岗位条件和已复核证据" /></div>
                  <label className="otto-recruitment-consent"><input type="checkbox" checked={decisionConfirmed} onChange={(event) => setDecisionConfirmed(event.target.checked)} /><span>我已人工复核原始材料，并确认由本人作出该决定</span></label>
                  <div className="otto-recruitment-actions"><button type="button" className="is-primary" onClick={saveDecision}>记录人工决定</button></div>
                </section>
              </> : renderEmpty('请先导入简历并填写岗位要求。') : null}

              {activeTarget === 'interview-audio' ? activeCandidate ? <>
                <div className="otto-recruitment-safety"><strong>仅分析回答内容</strong><span>不分析口音、音高、表情、情绪、性格或所谓自信程度。</span></div>
                <section className="otto-recruitment-card">
                  <header><div><strong>WhisperX 转写与说话人区分</strong><span>支持录音和含音轨的视频</span></div><button type="button" disabled={busy === 'audio'} onClick={() => void transcribeAudio()}>{busy === 'audio' ? '转写中…' : '选择面试录音'}</button></header>
                  {activeCandidate.transcriptWarning ? <p role="status" className="otto-recruitment-warning">{activeCandidate.transcriptWarning}</p> : null}
                  <textarea aria-label="面试转写" rows={12} value={activeCandidate.transcriptText} onChange={(event) => updateCandidate(activeCandidate.id, (candidate) => ({ ...candidate, transcriptText: event.target.value }))} placeholder="WhisperX 结果会显示在这里；也可以粘贴带时间戳的转写后人工校对。" />
                  <div className="otto-recruitment-actions"><button type="button" disabled={!activeCandidate.transcriptText.trim()} onClick={analyzeEditedTranscript}>按校对后的转写重新分析</button></div>
                </section>
                {activeCandidate.transcriptReport ? <section className="otto-recruitment-card">
                  <h4>回答证据检查</h4>
                  <div className="otto-recruitment-audio-grid"><div><strong>岗位知识证据</strong><span>{activeCandidate.transcriptReport.knowledgeEvidence.filter((item) => item.status === 'supported').length}</span></div><div><strong>STAR 证据段</strong><span>{activeCandidate.transcriptReport.starEvidence.filter((item) => item.result && item.action).length}</span></div><div><strong>需要追问</strong><span>{activeCandidate.transcriptReport.incompleteAnswers.length}</span></div><div><strong>待核实差异</strong><span>{activeCandidate.transcriptReport.inconsistencies.length}</span></div></div>
                  <div className="otto-recruitment-findings">{activeCandidate.transcriptReport.knowledgeEvidence.map((finding) => <article key={finding.criterion} className={`is-${finding.status}`}><header><div><span>岗位知识</span><strong>{finding.criterion}</strong></div><b>{findingStatusLabel(finding.status)} · {Math.round(finding.confidence * 100)}% 规则可信度</b></header><p>{finding.rule}</p>{finding.evidence.length ? <blockquote>{finding.evidence.map((evidence) => <span key={`${evidence.timestamp}-${evidence.quote}`}>[{formatTimestamp(evidence.timestamp)}] {evidence.quote}</span>)}</blockquote> : <small>回答中没有可直接引用的证据。</small>}</article>)}</div>
                  {[...activeCandidate.transcriptReport.incompleteAnswers, ...activeCandidate.transcriptReport.inconsistencies].map((item) => <p key={item}>{item}</p>)}
                </section> : null}
              </> : renderEmpty('请先选择候选人，再导入面试录音。') : null}

              {activeTarget === 'interview-kit' ? activeCandidate?.semanticEvaluation && interviewKit ? <>
                <section className="otto-recruitment-card">
                  <header><div><strong>{jobTitle || '当前岗位'}面试提纲</strong><span>模型结合候选人全文的强项、风险和信息缺口生成</span></div><button type="button" disabled={busy === 'export'} onClick={() => void exportText(`${jobTitle || '岗位'}-${activeCandidate.analysis.identity.name || '候选人'}-面试提纲.md`, ['# 智能面试提纲', '', ...interviewKit.questions.flatMap((question, index) => [`## ${index + 1}. ${question.question}`, '', `提问原因：${question.rationale}`, '', `评价提示：${question.rubric}`, '', ...question.followUps.map((followUp) => `- 追问：${followUp}`), ...question.goodSignals.map((signal) => `- 积极信号：${signal}`), ...question.concernSignals.map((signal) => `- 关注信号：${signal}`), ''])].join('\n'), '导出全文语义面试提纲')}>导出提纲</button></header>
                  <div className="otto-recruitment-questions">{interviewKit.questions.map((question, index) => <article key={question.id}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{question.question}</strong><p>为什么问：{question.rationale}</p>{question.followUps.map((followUp) => <small key={followUp}>追问：{followUp}</small>)}<details><summary>评价参考</summary>{question.goodSignals.map((signal) => <small key={signal}>积极信号：{signal}</small>)}{question.concernSignals.map((signal) => <small key={signal}>关注信号：{signal}</small>)}</details></div></article>)}</div>
                </section>
                <section className="otto-recruitment-card"><header><div><strong>面试记录</strong><span>汇总时间戳原文、岗位知识证据、STAR 和人工备注</span></div><button type="button" disabled={!activeCandidate.transcriptReport || busy === 'export'} onClick={() => { if (!activeCandidate.transcriptReport) return; void exportText(`${jobTitle || '岗位'}-${activeCandidate.analysis.identity.name || '候选人'}-面试记录.md`, buildInterviewRecord({ jobTitle, candidate: activeCandidate.analysis, transcript: activeCandidate.transcriptReport, reviewerNotes: interviewNotes }), '导出面试记录'); }}>导出面试记录</button></header><textarea aria-label="面试人员备注" rows={4} value={interviewNotes} onChange={(event) => setInterviewNotes(event.target.value)} placeholder="填写招聘人员观察、待核实事项和下一轮安排。没有完成录音转写前，面试记录不会导出。" /></section>
                <section className="otto-recruitment-card"><header><div><strong>候选人对比报告</strong><span>对比全文语义维度和证据覆盖，不自动排名</span></div><button type="button" disabled={busy === 'export'} onClick={() => void exportText(`${jobTitle || '岗位'}-候选人全文语义对比.md`, buildCandidateComparisonReport(candidates.map((candidate) => ({ analysis: candidate.analysis, semanticEvaluation: candidate.semanticEvaluation }))), '导出候选人全文语义对比报告')}>导出对比报告</button></header><pre className="otto-recruitment-report-preview">{buildCandidateComparisonReport(candidates.map((candidate) => ({ analysis: candidate.analysis, semanticEvaluation: candidate.semanticEvaluation })))}</pre></section>
              </> : renderEmpty('完成全文智能分析后，Otto 会针对该候选人的强项、风险和信息缺口生成问题。') : null}

              {activeTarget === 'privacy-audit' ? <>
                <div className="otto-recruitment-safety"><strong>敏感属性不参与评价</strong><span>姓名、联系方式、年龄、性别和出生日期与证据分析分开保存，永不作为匹配规则。</span></div>
                {activeCandidate ? <section className="otto-recruitment-card otto-recruitment-privacy">
                  <header><div><strong>候选人授权与隔离</strong><span>{activeCandidate.fileName}</span></div><button type="button" className="is-danger" onClick={() => purgeCandidate(activeCandidate)}>立即清除材料</button></header>
                  <dl><div><dt>授权时间</dt><dd>{new Date(activeCandidate.consentAt).toLocaleString('zh-CN')}</dd></div><div><dt>保存期限</dt><dd>{activeCandidate.retentionDays} 天，至 {new Date(activeCandidate.expiresAt).toLocaleDateString('zh-CN')}</dd></div><div><dt>身份字段</dt><dd>{Object.keys(activeCandidate.analysis.identity).length} 项，已隔离</dd></div><div><dt>评价输入</dt><dd>仅使用脱敏后的经历、项目、技能和回答内容</dd></div></dl>
                </section> : null}
                <section className="otto-recruitment-card"><header><div><strong>审计记录</strong><span>记录模型版本、人工修改和最终决定</span></div><span>{audits.length} 条</span></header><div className="otto-recruitment-audit">{audits.map((audit) => <article key={audit.id}><time>{new Date(audit.createdAt).toLocaleString('zh-CN')}</time><div><strong>{audit.action}</strong><p>{audit.detail}</p><small>{audit.actorType === 'human' ? '人工操作' : '系统规则'} · {audit.modelVersion || '无模型参与'}</small></div></article>)}</div></section>
              </> : null}

              {error ? <p role="alert" className="otto-recruitment-message is-error">{error}</p> : null}
              {notice ? <p role="status" className="otto-recruitment-message is-notice">{notice}</p> : null}
            </main>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
