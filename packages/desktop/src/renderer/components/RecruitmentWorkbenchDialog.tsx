/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  type InterviewTranscriptAnalysis,
} from '../recruitmentAnalysis.js';

interface RecruitmentAuditEvent {
  id: string;
  candidateId: string;
  action: string;
  actorType: 'human' | 'system';
  modelVersion: string | null;
  detail: string;
  createdAt: string;
}

interface CandidateWorkspace {
  id: string;
  fileName: string;
  consentAt: string;
  retentionDays: number;
  expiresAt: string;
  analysis: CandidateResumeAnalysis;
  transcriptText: string;
  transcriptReport: InterviewTranscriptAnalysis | null;
  transcriptWarning: string;
  decision: HiringDecisionAudit | null;
}

const TARGET_LABELS: Readonly<Record<RecruitmentModuleTarget, string>> = {
  'resume-analysis': '简历分析',
  'candidate-screening': '人员初步分析',
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
  return {
    id: `recruitment-audit:${crypto.randomUUID()}`,
    candidateId,
    action,
    actorType,
    modelVersion,
    detail,
    createdAt: new Date().toISOString(),
  };
}

function findingStatusLabel(status: CandidateResumeAnalysis['findings'][number]['status']): string {
  if (status === 'supported') return '有直接证据';
  if (status === 'uncertain') return '证据不足';
  return '未找到证据';
}

export function RecruitmentWorkbenchDialog({
  open,
  target,
  reviewerId,
  organizationName,
  onClose,
}: {
  open: boolean;
  target: RecruitmentModuleTarget;
  reviewerId: string;
  organizationName: string;
  onClose(): void;
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [activeTarget, setActiveTarget] = useState<RecruitmentModuleTarget>(target);
  const [jobTitle, setJobTitle] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [retentionDays, setRetentionDays] = useState(30);
  const [candidates, setCandidates] = useState<CandidateWorkspace[]>([]);
  const [activeCandidateId, setActiveCandidateId] = useState('');
  const [audits, setAudits] = useState<RecruitmentAuditEvent[]>([]);
  const [busy, setBusy] = useState<'resume' | 'audio' | 'export' | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [decision, setDecision] = useState<HiringDecisionAudit['decision']>('hold');
  const [decisionRationale, setDecisionRationale] = useState('');
  const [decisionConfirmed, setDecisionConfirmed] = useState(false);
  const [interviewNotes, setInterviewNotes] = useState('');

  const activeCandidate = candidates.find((candidate) => candidate.id === activeCandidateId) ?? null;
  const interviewKit = useMemo(
    () => activeCandidate ? generateInterviewKit(activeCandidate.analysis) : null,
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
      const now = Date.now();
      const expired = candidates.filter((candidate) => Date.parse(candidate.expiresAt) <= now);
      if (!expired.length) return;
      const expiredIds = new Set(expired.map((candidate) => candidate.id));
      setCandidates((current) => current.filter((candidate) => !expiredIds.has(candidate.id)));
      setAudits((current) => [
        ...expired.map((candidate) => makeAudit(
          candidate.id,
          'retention_expired',
          `达到 ${candidate.retentionDays} 天保存期限，候选人材料已从当前工作台清除。`,
        )),
        ...current,
      ]);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [candidates, open]);

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
    try {
      const [filePath] = await window.otto.selectFiles();
      if (!filePath) return;
      if (!RESUME_EXTENSIONS.has(extension(filePath))) {
        throw new Error('简历仅支持 PDF、DOCX、TXT 或 Markdown 文件');
      }
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
      setCandidates((current) => [...current, {
        id: candidateId,
        fileName: extracted.fileName,
        consentAt,
        retentionDays,
        expiresAt,
        analysis,
        transcriptText: '',
        transcriptReport: null,
        transcriptWarning: '',
        decision: null,
      }]);
      setActiveCandidateId(candidateId);
      addAudit(makeAudit(candidateId, 'resume_analyzed',
        `已解析 ${extracted.sourceFormat.toUpperCase()} 简历；身份字段与能力评价已分离，保存期限 ${retentionDays} 天。`));
      setNotice('简历解析完成。Otto 只生成证据项和待核实问题，不会自动淘汰候选人。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
                  <strong>{candidate.analysis.identity.name || '候选人（身份已隔离）'}</strong>
                  <small>{candidate.fileName}</small>
                </button>
              ))}
              {candidates.length === 0 ? <p>导入简历后在此切换候选人。</p> : null}
            </aside>
            <main className="otto-recruitment__main">
              <div className="otto-recruitment__page-head">
                <div><span>OTTO OFFICIAL</span><h3>{TARGET_LABELS[activeTarget]}</h3></div>
                <small>分析引擎 {RECRUITMENT_ANALYSIS_VERSION}</small>
              </div>

              {activeTarget === 'resume-analysis' ? <>
                <section className="otto-recruitment-card otto-recruitment-setup">
                  <div className="otto-recruitment-fields">
                    <label><span>岗位名称</span><input aria-label="岗位名称" value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} placeholder="例如：高级前端工程师" /></label>
                    <label className="is-wide"><span>岗位要求</span><textarea aria-label="岗位要求" rows={6} value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="逐条填写必须条件和优先条件，Otto 将按原文寻找证据。" /></label>
                    <label><span>材料保存期限</span><select aria-label="材料保存期限" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></label>
                  </div>
                  <label className="otto-recruitment-consent"><input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} /><span>已取得候选人对本次招聘分析及限定期限保存材料的授权</span></label>
                  <div className="otto-recruitment-actions"><button type="button" className="is-primary" disabled={busy === 'resume'} onClick={() => void importResume()}>{busy === 'resume' ? '解析中…' : '导入 PDF / DOCX 简历'}</button></div>
                </section>
                {activeCandidate ? <section className="otto-recruitment-card">
                  <header><div><strong>{activeCandidate.analysis.identity.name || '候选人'}</strong><span>身份信息已与能力分析隔离</span></div><span>{activeCandidate.analysis.skills.length} 项技能 · {activeCandidate.analysis.timeline.length} 段时间线</span></header>
                  <div className="otto-recruitment-tags">{activeCandidate.analysis.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>
                  <h4>经历原文</h4>
                  {activeCandidate.analysis.experiences.length ? <ul>{activeCandidate.analysis.experiences.map((experience, index) => <li key={`${experience}-${index}`}>{experience}</li>)}</ul> : <p>暂未提取到明确任职经历，建议人工查看原简历。</p>}
                  <h4>项目原文</h4>
                  {activeCandidate.analysis.projects.length ? <ul>{activeCandidate.analysis.projects.map((project, index) => <li key={`${project}-${index}`}>{project}</li>)}</ul> : <p>暂未提取到明确项目描述，建议人工查看原简历。</p>}
                </section> : null}
              </> : null}

              {activeTarget === 'candidate-screening' ? activeCandidate ? <>
                <div className="otto-recruitment-safety"><strong>无自动淘汰</strong><span>以下是证据状态，不是录用概率或人格评分。点击原文即可回查。</span></div>
                <section className="otto-recruitment-findings" aria-label="岗位证据分析">
                  {activeCandidate.analysis.findings.map((finding) => <article key={finding.id} className={`is-${finding.status}`}>
                    <header><div><span>{finding.requirement === 'required' ? '必须条件' : '优先条件'}</span><strong>{finding.criterion}</strong></div><b>{findingStatusLabel(finding.status)} · {Math.round(finding.confidence * 100)}% 规则可信度</b></header>
                    <p>{finding.rule}</p>
                    {finding.evidence.length ? <blockquote>{finding.evidence.map((evidence) => <span key={`${evidence.line}-${evidence.quote}`}>第 {evidence.line} 行：{evidence.quote}</span>)}</blockquote> : <small>没有找到可直接引用的简历原文。</small>}
                  </article>)}
                </section>
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

              {activeTarget === 'interview-kit' ? activeCandidate && interviewKit ? <>
                <section className="otto-recruitment-card">
                  <header><div><strong>{jobTitle || '当前岗位'}面试提纲</strong><span>从证据不足项生成，不虚构候选人经历</span></div><button type="button" disabled={busy === 'export'} onClick={() => void exportText(`${jobTitle || '岗位'}-${activeCandidate.analysis.identity.name || '候选人'}-面试提纲.md`, ['# 结构化面试提纲', '', ...interviewKit.questions.flatMap((question, index) => [`## ${index + 1}. ${question.question}`, '', `评价规则：${question.rubric}`, '', ...question.followUps.map((followUp) => `- 追问：${followUp}`), ''])].join('\n'), '导出结构化面试提纲')}>导出提纲</button></header>
                  <div className="otto-recruitment-questions">{interviewKit.questions.map((question, index) => <article key={question.id}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{question.question}</strong><p>{question.rubric}</p>{question.followUps.map((followUp) => <small key={followUp}>追问：{followUp}</small>)}</div></article>)}</div>
                </section>
                <section className="otto-recruitment-card"><header><div><strong>面试记录</strong><span>汇总时间戳原文、岗位知识证据、STAR 和人工备注</span></div><button type="button" disabled={!activeCandidate.transcriptReport || busy === 'export'} onClick={() => { if (!activeCandidate.transcriptReport) return; void exportText(`${jobTitle || '岗位'}-${activeCandidate.analysis.identity.name || '候选人'}-面试记录.md`, buildInterviewRecord({ jobTitle, candidate: activeCandidate.analysis, transcript: activeCandidate.transcriptReport, reviewerNotes: interviewNotes }), '导出面试记录'); }}>导出面试记录</button></header><textarea aria-label="面试人员备注" rows={4} value={interviewNotes} onChange={(event) => setInterviewNotes(event.target.value)} placeholder="填写招聘人员观察、待核实事项和下一轮安排。没有完成录音转写前，面试记录不会导出。" /></section>
                <section className="otto-recruitment-card"><header><div><strong>候选人对比报告</strong><span>只对比证据覆盖情况，不自动排名</span></div><button type="button" disabled={busy === 'export'} onClick={() => void exportText(`${jobTitle || '岗位'}-候选人证据对比.md`, buildCandidateComparisonReport(candidates.map((candidate) => candidate.analysis)), '导出候选人证据对比报告')}>导出对比报告</button></header><pre className="otto-recruitment-report-preview">{buildCandidateComparisonReport(candidates.map((candidate) => candidate.analysis))}</pre></section>
              </> : renderEmpty('完成简历分析后，Otto 会根据弱项生成结构化问题和追问。') : null}

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
