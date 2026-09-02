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
import { inferRecruitmentJobTitle } from '../recruitmentGoal.js';

type RecruitmentPanel = 'evidence' | 'interview' | 'compare' | 'decision' | 'privacy' | null;

function panelForTarget(target: RecruitmentModuleTarget): RecruitmentPanel {
  if (target === 'interview-audio' || target === 'interview-kit') return 'interview';
  if (target === 'privacy-audit') return 'privacy';
  if (target === 'candidate-screening') return 'evidence';
  return null;
}

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

function evidenceLabel(evidence: { source?: 'resume' | 'interview'; line: number; quote: string }): string {
  return `${evidence.source === 'interview' ? '面试转写' : '简历'}第 ${evidence.line} 行：${evidence.quote}`;
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
  const [activePanel, setActivePanel] = useState<RecruitmentPanel>(panelForTarget(target));
  const [showAdvanced, setShowAdvanced] = useState(false);
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
    setActivePanel(panelForTarget(target));
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
    if (!jobDescription.trim()) {
      setError('先用一句话告诉 Otto 你要招什么人。');
      return;
    }
    if (!activeCandidate && !consentConfirmed) {
      setError('请先确认已取得候选人材料的分析与限期保存授权。');
      return;
    }
    setBusy('resume');
    setResumeProgress('');
    try {
      const filePaths = (await window.otto.selectFiles()).slice(0, 20);
      if (!filePaths.length) return;
      const resumePaths = filePaths.filter((filePath) => RESUME_EXTENSIONS.has(extension(filePath)));
      const audioPaths = filePaths.filter((filePath) => AUDIO_EXTENSIONS.has(extension(filePath)));
      let pendingAudioPaths = audioPaths;
      if (!resumePaths.length && !audioPaths.length) {
        throw new Error('请选择 PDF、DOCX、TXT、Markdown 简历，或常见音频/视频文件');
      }
      if (resumePaths.length && !consentConfirmed) {
        throw new Error('请先确认已取得本批候选人的材料分析授权');
      }
      const resolvedJobTitle = jobTitle.trim() || inferRecruitmentJobTitle(jobDescription);
      if (!jobTitle.trim()) setJobTitle(resolvedJobTitle);
      const imported: CandidateWorkspace[] = [];
      let failed = 0;
      if (!resumePaths.length && audioPaths.length && !activeCandidate) {
        const filePath = audioPaths[0];
        setResumeProgress('Otto 正在转写面试材料并建立候选人档案');
        const result = await window.otto.recruitmentTranscribe(filePath);
        const rawTranscript = result.segments.map((segment) => (
          `[${formatTimestamp(segment.startSeconds)}] ${segment.speaker}：${segment.text}`
        )).join('\n');
        if (!rawTranscript.trim()) throw new Error('面试材料中没有提取到可分析的语音文字');
        const candidateId = `candidate:${crypto.randomUUID()}`;
        const analysis = analyzeCandidateResume({
          candidateId,
          resumeText: rawTranscript,
          jobDescription,
        });
        const transcriptText = analysis.redactedResume;
        const transcriptReport = analyzeInterviewTranscript({
          transcript: transcriptText,
          redactedResume: '当前候选人未提供简历，履历信息需要后续补充核实。',
          jobDescription,
        });
        const semanticEvaluation = await window.otto.recruitmentAnalyzeResume({
          candidateId,
          jobTitle: resolvedJobTitle,
          jobDescription,
          redactedResume: '当前候选人未提供简历，请只根据面试转写判断，并将缺少的履历信息列为待核实事项。',
          interviewTranscript: transcriptText,
        });
        const consentAt = new Date().toISOString();
        imported.push({
          id: candidateId,
          fileName: filePath.split(/[\\/]/u).at(-1) || '面试材料',
          consentAt,
          retentionDays,
          expiresAt: new Date(Date.now() + retentionDays * 86_400_000).toISOString(),
          analysis,
          semanticEvaluation,
          semanticError: '',
          semanticMaterials: 'interview',
          jobTitleSnapshot: resolvedJobTitle,
          jobDescriptionSnapshot: jobDescription,
          transcriptText,
          transcriptReport,
          transcriptWarning: result.warning ?? '',
          decision: null,
        });
        addAudit(makeAudit(
          candidateId,
          'interview_only_analyzed',
          `未提供简历；已使用 ${result.model} 完成转写并建立候选人档案，履历信息标记为待核实。`,
          'system',
          `${semanticEvaluation.analysisVersion}/${semanticEvaluation.modelProvider}`,
        ));
        pendingAudioPaths = audioPaths.slice(1);
      }
      for (let index = 0; index < resumePaths.length; index += 1) {
        const filePath = resumePaths[index];
        setResumeProgress(`Otto 正在阅读第 ${index + 1}/${resumePaths.length} 份简历`);
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
              jobTitle: resolvedJobTitle,
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
            semanticMaterials: semanticEvaluation ? 'resume' : undefined,
            jobTitleSnapshot: resolvedJobTitle,
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
      if (resumePaths.length && !imported.length) {
        throw new Error('所选文件均未能提取出可分析的简历正文');
      }
      if (imported.length) {
        setCandidates((current) => [...current, ...imported]);
        setActiveCandidateId(imported[0].id);
        setConsentConfirmed(false);
      }
      const analyzed = imported.filter((candidate) => candidate.semanticEvaluation).length;
      const modelFailed = imported.length - analyzed;
      let mediaMessage = '';
      const mediaCandidate = imported.length === 1
        ? imported[0]
        : imported.length === 0 ? activeCandidate : null;
      if (pendingAudioPaths.length && mediaCandidate) {
        setResumeProgress('正在转写面试材料并与简历交叉核验');
        await analyzeInterviewFile(pendingAudioPaths[0], mediaCandidate);
        mediaMessage = '，并完成简历与面试材料联合分析';
        if (pendingAudioPaths.length > 1) mediaMessage += `；其余 ${pendingAudioPaths.length - 1} 个媒体文件请逐个添加`;
      } else if (pendingAudioPaths.length) {
        mediaMessage = '；音视频尚未处理，请先从左侧选择它对应的候选人再添加';
      }
      setActivePanel(null);
      const importedMessage = resumePaths.length
        ? `已导入 ${imported.length} 份简历，${analyzed} 份完成智能分析`
        : imported.length
          ? '已从面试材料建立候选人档案并完成智能分析'
          : '材料处理完成';
      setNotice(`${importedMessage}${modelFailed ? `，${modelFailed} 份可重试` : ''}${failed ? `；${failed} 个文件未能读取` : ''}${mediaMessage}。`);
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
        jobTitle: jobTitle.trim() || inferRecruitmentJobTitle(jobDescription),
        jobDescription,
        redactedResume: activeCandidate.analysis.redactedResume,
        ...(activeCandidate.transcriptText.trim()
          ? { interviewTranscript: activeCandidate.transcriptText }
          : {}),
      });
      updateCandidate(activeCandidate.id, (candidate) => ({
        ...candidate,
        semanticEvaluation,
        semanticError: '',
        semanticMaterials: activeCandidate.transcriptText.trim() ? 'resume_interview' : 'resume',
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

  async function analyzeInterviewFile(filePath: string, candidate: CandidateWorkspace): Promise<void> {
    if (!AUDIO_EXTENSIONS.has(extension(filePath))) {
      throw new Error('请选择受支持的面试录音或视频文件');
    }
    const result = await window.otto.recruitmentTranscribe(filePath);
    const transcriptText = result.segments.map((segment) => (
      `[${formatTimestamp(segment.startSeconds)}] ${segment.speaker}：${segment.text}`
    )).join('\n');
    const transcriptReport = analyzeInterviewTranscript({
      transcript: transcriptText,
      redactedResume: candidate.analysis.redactedResume,
      jobDescription,
    });
    const resolvedJobTitle = jobTitle.trim() || inferRecruitmentJobTitle(jobDescription);
    const semanticEvaluation = await window.otto.recruitmentAnalyzeResume({
      candidateId: candidate.id,
      jobTitle: resolvedJobTitle,
      jobDescription,
      redactedResume: candidate.analysis.redactedResume,
      interviewTranscript: transcriptText,
    });
    updateCandidate(candidate.id, (current) => ({
      ...current,
      transcriptText,
      transcriptReport,
      transcriptWarning: result.warning ?? '',
      semanticEvaluation,
      semanticError: '',
      semanticMaterials: 'resume_interview',
      jobTitleSnapshot: resolvedJobTitle,
      jobDescriptionSnapshot: jobDescription,
    }));
    addAudit(makeAudit(candidate.id, 'interview_cross_checked',
      `WhisperX 完成 ${result.segments.length} 段转写；当前模型已将面试回答与简历全文、岗位要求联合分析。`,
      'system', `${semanticEvaluation.analysisVersion}/${semanticEvaluation.modelProvider}`));
  }

  const transcribeAudio = async (): Promise<void> => {
    if (!activeCandidate) { setError('请先选择一位候选人，再添加对应的面试录音或视频。'); return; }
    setBusy('audio'); setError(''); setNotice('');
    try {
      const [filePath] = await window.otto.selectFiles();
      if (!filePath) return;
      await analyzeInterviewFile(filePath, activeCandidate);
      setActivePanel(null);
      setNotice('已把面试回答与简历全文联合分析，候选人结论和后续问题已更新。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  const analyzeEditedTranscript = async (): Promise<void> => {
    if (!activeCandidate || !activeCandidate.transcriptText.trim()) return;
    setBusy('audio'); setError('');
    try {
      const transcriptReport = analyzeInterviewTranscript({
        transcript: activeCandidate.transcriptText,
        redactedResume: activeCandidate.analysis.redactedResume,
        jobDescription,
      });
      const semanticEvaluation = await window.otto.recruitmentAnalyzeResume({
        candidateId: activeCandidate.id,
        jobTitle: jobTitle.trim() || inferRecruitmentJobTitle(jobDescription),
        jobDescription,
        redactedResume: activeCandidate.analysis.redactedResume,
        interviewTranscript: activeCandidate.transcriptText,
      });
      updateCandidate(activeCandidate.id, (candidate) => ({
        ...candidate,
        transcriptReport,
        semanticEvaluation,
        semanticError: '',
        semanticMaterials: 'resume_interview',
      }));
      addAudit(makeAudit(activeCandidate.id, 'transcript_reviewed', '招聘人员修订转写后，模型重新联合分析简历与面试回答。', 'human', `${semanticEvaluation.analysisVersion}/${semanticEvaluation.modelProvider}`));
      setNotice('已按校对后的面试转写更新候选人综合结论。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
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

  const evaluation = activeCandidate?.semanticEvaluation ?? null;
  const nextStep = evaluation?.missingInformation[0]
    ? `先核实：${evaluation.missingInformation[0]}`
    : evaluation?.risks[0]
      ? `面试重点：${evaluation.risks[0]}`
      : activeCandidate?.transcriptText
        ? '整理面试结论并由招聘人员决定下一步'
        : '添加面试录音或视频，让 Otto 验证简历中的关键说法';
  const togglePanel = (panel: Exclude<RecruitmentPanel, null>): void => {
    setActivePanel((current) => current === panel ? null : panel);
    setError('');
  };

  return createPortal(
    <div className="otto-workspace-dialog-overlay otto-recruitment-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="otto-workspace-dialog otto-recruitment" role="dialog" aria-modal="true" aria-label="智能招聘">
        <header>
          <div><h2>智能招聘助手</h2><p>{organizationName} · 说清目标，放入材料，其余交给 Otto</p></div>
          <button ref={closeRef} type="button" aria-label="关闭智能招聘" onClick={onClose}>×</button>
        </header>
        <div className="otto-recruitment__shell">
          <div className="otto-recruitment__workspace">
            <aside className="otto-recruitment__candidates" aria-label="候选人">
              <div><strong>候选人档案</strong><span>{candidates.length}</span></div>
              {candidates.map((candidate) => (
                <button key={candidate.id} type="button" className={candidate.id === activeCandidateId ? 'is-active' : ''} onClick={() => setActiveCandidateId(candidate.id)}>
                  <span><strong>{candidate.analysis.identity.name || '候选人（身份已隔离）'}</strong>{candidate.semanticEvaluation ? <b>{candidate.semanticEvaluation.overallScore}</b> : <b className="is-pending">待分析</b>}</span>
                  <small>{candidate.semanticMaterials === 'resume_interview' ? '简历 + 面试已联合分析' : candidate.semanticMaterials === 'interview' ? '面试材料已分析' : candidate.fileName}</small>
                </button>
              ))}
              {candidates.length === 0 ? <p>分析过的候选人会持续保存在这里，不必重复上传和提问。</p> : null}
            </aside>
            <main className="otto-recruitment__main">
              <section className={`otto-recruitment-start ${candidates.length ? 'is-compact' : ''}`}>
                <div className="otto-recruitment-start__copy"><span>直接开始</span><h3>告诉 Otto 你要招什么人</h3><p>例如：“我要招一名前端工程师，能独立完成 Electron 产品，重视交付。”然后一次选择简历或面试视频。</p></div>
                <textarea aria-label="招聘目标" rows={candidates.length ? 2 : 4} value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="我要招一名……，主要负责……，最看重……" />
                <button type="button" className="otto-recruitment-advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? '收起设置' : '可选：调整岗位名称与保存时间'}</button>
                {showAdvanced ? <div className="otto-recruitment-advanced"><label><span>岗位名称</span><input aria-label="岗位名称" value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} placeholder={inferRecruitmentJobTitle(jobDescription)} /></label><label><span>材料保存</span><select aria-label="材料保存期限" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></label></div> : null}
                <label className="otto-recruitment-consent"><input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} /><span>已取得本次所选候选人材料的分析与限期保存授权</span></label>
                <div className="otto-recruitment-start__action"><button type="button" className="is-primary" disabled={busy === 'resume'} onClick={() => void importResume()}>{busy === 'resume' ? (resumeProgress || 'Otto 正在分析…') : '选择简历或面试视频，开始分析'}</button><small>可批量选择，身份信息先在本地隔离</small></div>
                {!candidates.length ? <div className="otto-recruitment-value"><span><b>1</b>一次读完整材料</span><span><b>2</b>简历与面试互证</span><span><b>3</b>持续保存候选人档案</span></div> : null}
              </section>

              {error ? <p role="alert" className="otto-recruitment-message is-error">{error}</p> : null}
              {notice ? <p role="status" className="otto-recruitment-message is-notice">{notice}</p> : null}

              {!activeCandidate ? <section className="otto-recruitment-welcome"><strong>一句话加一份材料就够了</strong><p>Otto 会自动理解岗位、阅读全文、给出可回查证据，并生成只针对这位候选人的面试问题。之后再加入面试视频，结论会在同一档案中继续更新。</p></section> : null}

              {activeCandidate && evaluation ? <>
                <section className="otto-recruitment-result-hero">
                  <div className="otto-recruitment-score"><strong>{evaluation.overallScore}</strong><span>当前材料贴合度</span><small>{matchLevelLabel(evaluation.matchLevel)}</small></div>
                  <div><header><span>{activeCandidate.semanticMaterials === 'resume_interview' ? '简历 + 面试联合结论' : activeCandidate.semanticMaterials === 'interview' ? '面试材料结论' : '简历全文结论'}</span><b>证据覆盖 {evaluation.evidenceCoverage}%</b></header><h3>{activeCandidate.analysis.identity.name || '当前候选人'}</h3><p>{evaluation.summary}</p><small>匹配度不是录用概率，最终决定由招聘人员作出。</small></div>
                </section>
                {(activeCandidate.jobTitleSnapshot !== (jobTitle.trim() || inferRecruitmentJobTitle(jobDescription)) || activeCandidate.jobDescriptionSnapshot !== jobDescription) ? <p className="otto-recruitment-warning">招聘目标已修改。点击“按当前目标重新分析”后再使用此结论。</p> : null}
                <section className="otto-recruitment-briefing">
                  <article className="is-positive"><header><strong>为什么值得继续看</strong></header><ul>{evaluation.strengths.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul></article>
                  <article className="is-caution"><header><strong>现在还不能确定</strong></header><ul>{[...evaluation.risks, ...evaluation.missingInformation].slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul></article>
                  <article className="is-next"><header><strong>Otto 建议的下一步</strong></header><p>{nextStep}</p>{interviewKit?.questions[0] ? <small>首问：{interviewKit.questions[0].question}</small> : null}</article>
                </section>
                <div className="otto-recruitment-command-bar" aria-label="候选人下一步操作">
                  <button type="button" className="is-primary" disabled={busy === 'audio'} onClick={() => void transcribeAudio()}>{busy === 'audio' ? '联合分析中…' : activeCandidate.transcriptText ? '更新面试录音或视频' : '加入面试录音或视频'}</button>
                  <button type="button" onClick={() => togglePanel('interview')}>面试方案</button>
                  <button type="button" onClick={() => togglePanel('evidence')}>查看原文证据</button>
                  {candidates.length > 1 ? <button type="button" onClick={() => togglePanel('compare')}>比较 {candidates.length} 位候选人</button> : null}
                  <button type="button" onClick={() => togglePanel('decision')}>记录人工结论</button>
                  <button type="button" onClick={() => togglePanel('privacy')}>资料与隐私</button>
                  <button type="button" disabled={busy === 'reanalyze'} onClick={() => void reanalyzeCandidate()}>{busy === 'reanalyze' ? '分析中…' : '按当前目标重新分析'}</button>
                </div>

                {activePanel === 'evidence' ? <section className="otto-recruitment-panel">
                  <header><div><strong>判断依据</strong><span>每条结论都能回到简历或面试原文</span></div><small>{evaluation.modelProvider} · {RECRUITMENT_SEMANTIC_ANALYSIS_VERSION}</small></header>
                  <div className="otto-recruitment-dimensions" aria-label="全文语义分析维度">{evaluation.dimensions.map((dimension) => <article key={dimension.id}><header><div><strong>{dimension.label}</strong><span>{dimension.assessment}</span></div><b>{dimension.score}</b></header><div className="otto-recruitment-meter"><i style={{ width: `${dimension.score}%` }} /></div>{dimension.evidence.length ? <blockquote>{dimension.evidence.map((item) => <span key={`${item.source}-${item.line}-${item.quote}`}>{evidenceLabel(item)}</span>)}</blockquote> : <p className="otto-recruitment-no-evidence">当前材料没有可回查证据。</p>}{dimension.uncertainties.length ? <ul>{dimension.uncertainties.map((item) => <li key={item}>待核实：{item}</li>)}</ul> : null}</article>)}</div>
                  <div className="otto-recruitment-hard-requirements">{evaluation.hardRequirements.map((requirement, index) => <article key={`${requirement.requirement}-${index}`} className={`is-${requirement.status}`}><header><strong>{requirement.requirement}</strong><b>{hardRequirementLabel(requirement.status)}</b></header><p>{requirement.explanation}</p>{requirement.evidence.length ? <blockquote>{requirement.evidence.map((item) => <span key={`${item.source}-${item.line}-${item.quote}`}>{evidenceLabel(item)}</span>)}</blockquote> : null}</article>)}</div>
                </section> : null}

                {activePanel === 'interview' && interviewKit ? <section className="otto-recruitment-panel">
                  <header><div><strong>针对这位候选人的面试方案</strong><span>问题来自其优势、风险与材料缺口，不是通用题库</span></div><button type="button" disabled={busy === 'export'} onClick={() => void exportText(`${jobTitle || '岗位'}-${activeCandidate.analysis.identity.name || '候选人'}-面试提纲.md`, ['# 智能面试提纲', '', ...interviewKit.questions.flatMap((question, index) => [`## ${index + 1}. ${question.question}`, '', `提问原因：${question.rationale}`, '', `评价提示：${question.rubric}`, '', ...question.followUps.map((followUp) => `- 追问：${followUp}`), ...question.goodSignals.map((signal) => `- 积极信号：${signal}`), ...question.concernSignals.map((signal) => `- 关注信号：${signal}`), ''])].join('\n'), '导出全文语义面试提纲')}>导出</button></header>
                  <div className="otto-recruitment-questions">{interviewKit.questions.map((question, index) => <article key={question.id}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{question.question}</strong><p>为什么问：{question.rationale}</p>{question.followUps.map((followUp) => <small key={followUp}>追问：{followUp}</small>)}<details><summary>回答观察点</summary>{question.goodSignals.map((signal) => <small key={signal}>积极信号：{signal}</small>)}{question.concernSignals.map((signal) => <small key={signal}>关注信号：{signal}</small>)}</details></div></article>)}</div>
                  {activeCandidate.transcriptText ? <><div className="otto-recruitment-safety"><strong>面试已与简历联合分析</strong><span>只分析回答文字，不使用口音、音高、表情、情绪或所谓自信程度。</span></div><textarea aria-label="面试转写" rows={8} value={activeCandidate.transcriptText} onChange={(event) => updateCandidate(activeCandidate.id, (candidate) => ({ ...candidate, transcriptText: event.target.value }))} /><div className="otto-recruitment-actions"><button type="button" disabled={busy === 'audio'} onClick={() => void analyzeEditedTranscript()}>按校对后的文字更新结论</button></div></> : <button type="button" className="otto-recruitment-media-empty" onClick={() => void transcribeAudio()}>添加面试录音或视频，验证简历中的关键说法</button>}
                  <textarea aria-label="面试人员备注" rows={3} value={interviewNotes} onChange={(event) => setInterviewNotes(event.target.value)} placeholder="人工备注：记录关键观察和下一轮安排" />
                  <div className="otto-recruitment-actions"><button type="button" disabled={!activeCandidate.transcriptReport || busy === 'export'} onClick={() => { if (!activeCandidate.transcriptReport) return; void exportText(`${jobTitle || '岗位'}-${activeCandidate.analysis.identity.name || '候选人'}-面试记录.md`, buildInterviewRecord({ jobTitle, candidate: activeCandidate.analysis, transcript: activeCandidate.transcriptReport, reviewerNotes: interviewNotes }), '导出面试记录'); }}>导出完整面试记录</button></div>
                </section> : null}

                {activePanel === 'compare' ? <section className="otto-recruitment-panel otto-recruitment-comparison"><header><div><strong>候选人横向比较</strong><span>统一岗位口径，保持导入顺序，不自动排名</span></div><button type="button" disabled={busy === 'export'} onClick={() => void exportText(`${jobTitle || '岗位'}-候选人全文语义对比.md`, buildCandidateComparisonReport(candidates.map((candidate) => ({ analysis: candidate.analysis, semanticEvaluation: candidate.semanticEvaluation }))), '导出候选人全文语义对比报告')}>导出</button></header><div><table><thead><tr><th>候选人</th><th>综合</th><th>核心能力</th><th>经验深度</th><th>交付结果</th><th>证据覆盖</th></tr></thead><tbody>{candidates.map((candidate) => { const item = candidate.semanticEvaluation; const dimensions = new Map(item?.dimensions.map((dimension) => [dimension.id, dimension.score]) ?? []); return <tr key={candidate.id}><td>{candidate.analysis.identity.name || candidate.fileName}</td><td>{item?.overallScore ?? '待分析'}</td><td>{dimensions.get('core_capability') ?? '—'}</td><td>{dimensions.get('experience_depth') ?? '—'}</td><td>{dimensions.get('delivery_impact') ?? '—'}</td><td>{item ? `${item.evidenceCoverage}%` : '—'}</td></tr>; })}</tbody></table></div></section> : null}

                {activePanel === 'decision' ? <section className="otto-recruitment-panel otto-recruitment-decision"><header><div><strong>记录招聘人员结论</strong><span>模型提供材料分析，但无权决定录用或淘汰</span></div>{activeCandidate.decision ? <b>已记录：{activeCandidate.decision.decision}</b> : null}</header><div><select aria-label="人工决定" value={decision} onChange={(event) => setDecision(event.target.value as HiringDecisionAudit['decision'])}><option value="shortlist">进入下一轮</option><option value="hold">待补充材料</option><option value="reject">人工淘汰</option></select><textarea aria-label="人工判断依据" rows={3} value={decisionRationale} onChange={(event) => setDecisionRationale(event.target.value)} placeholder="写明已复核的材料依据" /></div><label className="otto-recruitment-consent"><input type="checkbox" checked={decisionConfirmed} onChange={(event) => setDecisionConfirmed(event.target.checked)} /><span>我已人工复核原始材料，并确认由本人作出该决定</span></label><div className="otto-recruitment-actions"><button type="button" className="is-primary" onClick={saveDecision}>记录人工决定</button></div></section> : null}

                {activePanel === 'privacy' ? <section className="otto-recruitment-panel"><div className="otto-recruitment-safety"><strong>敏感属性不参与评价</strong><span>姓名、联系方式、年龄、性别和出生日期不会进入模型判断。</span></div><div className="otto-recruitment-privacy"><header><div><strong>候选人材料</strong><span>{activeCandidate.fileName}</span></div><button type="button" className="is-danger" onClick={() => purgeCandidate(activeCandidate)}>立即清除材料</button></header><dl><div><dt>授权时间</dt><dd>{new Date(activeCandidate.consentAt).toLocaleString('zh-CN')}</dd></div><div><dt>保存期限</dt><dd>{activeCandidate.retentionDays} 天</dd></div><div><dt>联合材料</dt><dd>{activeCandidate.semanticMaterials === 'resume_interview' ? '简历与面试转写' : activeCandidate.semanticMaterials === 'interview' ? '面试转写（未提供简历）' : '简历全文'}</dd></div><div><dt>身份字段</dt><dd>{Object.keys(activeCandidate.analysis.identity).length} 项，已隔离</dd></div></dl></div><div className="otto-recruitment-audit">{audits.filter((audit) => audit.candidateId === activeCandidate.id).map((audit) => <article key={audit.id}><time>{new Date(audit.createdAt).toLocaleString('zh-CN')}</time><div><strong>{audit.action}</strong><p>{audit.detail}</p></div></article>)}</div></section> : null}
              </> : null}

              {activeCandidate && !evaluation ? <section className="otto-recruitment-analysis-failed"><strong>Otto 暂时没有完成这份材料的智能分析</strong><p>{activeCandidate.semanticError || '候选人档案已保留，可以直接重试。'}</p><button type="button" disabled={busy === 'reanalyze'} onClick={() => void reanalyzeCandidate()}>重新分析</button></section> : null}

            </main>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
