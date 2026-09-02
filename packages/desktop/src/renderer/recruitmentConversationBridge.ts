/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  analyzeCandidateResume,
  analyzeInterviewTranscript,
  generateInterviewKit,
} from './recruitmentAnalysis.js';
import {
  makeRecruitmentAudit,
  type CandidateWorkspace,
  type RecruitmentWorkspaceStore,
} from './recruitmentWorkspaceStore.js';
import type { ConversationActionDraftSummary } from './conversationActionDraft.js';
import type {
  RecruitmentSemanticAnalysisInput,
  RecruitmentSemanticEvaluation,
} from '../main/recruitmentSemantic.js';
import { inferRecruitmentJobTitle, looksLikeNaturalRecruitmentGoal } from './recruitmentGoal.js';

const RECRUITMENT_DRAFT_TTL_MS = 30 * 60 * 1_000;
const MAX_DRAFTS = 1_000;
const MAX_CHAT_TEXT = 4_000;
const RESUME_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md', 'markdown']);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm', 'mp4', 'mov']);

type RecruitmentActionKind = 'resume-import' | 'audio-import' | 'purge-candidate';

export interface RecruitmentConversationDraft {
  id: string;
  kind: RecruitmentActionKind;
  sessionId: string;
  accountId: string;
  candidateId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface ExtractedDocument {
  filePath: string;
  fileName: string;
  sourceFormat: string;
  content: string;
}

interface RecruitmentTranscription {
  model: string;
  warning?: string;
  segments: Array<{ speaker: string; startSeconds: number; endSeconds?: number; text: string }>;
}

export interface RecruitmentConversationInput {
  text: string;
  sessionId: string;
  accountId: string;
  enabled: boolean;
  store: RecruitmentWorkspaceStore;
  registry: RecruitmentConversationDraftRegistry;
  selectFiles(): Promise<string[]>;
  extractDocument(path: string): Promise<ExtractedDocument>;
  analyzeResume(input: RecruitmentSemanticAnalysisInput): Promise<RecruitmentSemanticEvaluation>;
  transcribe(path: string): Promise<RecruitmentTranscription>;
  postMessage(role: 'user' | 'assistant', text: string): void;
  /** UI 草稿中心确认时必须绑定当前展示的草稿，拒绝串单或过期确认。 */
  expectedDraftId?: string;
  now?: () => number;
}

type RecruitmentIntent = RecruitmentActionKind | 'screening' | 'interview-kit' | 'privacy-audit';

function clean(value: unknown, limit = MAX_CHAT_TEXT): string {
  return typeof value === 'string'
    ? Array.from(value.trim()).slice(0, limit).join('')
    : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labeledValue(text: string, labels: readonly string[]): string {
  const pattern = labels.map(escapeRegExp).join('|');
  const match = text.match(new RegExp(`(?:${pattern})[：:\\s]+([^，,。；;\\n]+)`, 'u'));
  return clean(match?.[1]);
}

function detectIntent(text: string): RecruitmentIntent | null {
  if (/(?:介绍|解释|是什么|怎么用|如何使用|功能)/u.test(text)) return null;
  if (/(?:删除|清除).{0,8}(?:当前)?候选人(?:材料|数据|简历)/u.test(text)) return 'purge-candidate';
  if (/(?:招聘)?隐私与审计|招聘审计|候选人材料保存期限/u.test(text)) return 'privacy-audit';
  if (/(?:生成|查看|准备).{0,8}(?:面试材料|面试提纲|面试问题)/u.test(text)) return 'interview-kit';
  if (/(?:人员初步分析|候选人初步分析|候选人综合评估|简历匹配度|简历匹配证据|候选人证据)/u.test(text)) return 'screening';
  if (/(?:分析|处理|导入).{0,8}(?:面试录音|面试音频)|音频面试分析/u.test(text)) return 'audio-import';
  if (/(?:分析|导入|处理).{0,12}(?:简历|候选人材料|面试视频)|简历分析/u.test(text)) return 'resume-import';
  if (looksLikeNaturalRecruitmentGoal(text)) return 'resume-import';
  return null;
}

function extension(path: string): string {
  return path.split(/[\\/]/u).at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
}

function timestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function applyResumeContext(input: RecruitmentConversationInput): void {
  const naturalGoal = looksLikeNaturalRecruitmentGoal(input.text);
  const title = labeledValue(input.text, ['岗位名称', '职位名称', '招聘岗位'])
    || (naturalGoal ? inferRecruitmentJobTitle(input.text) : '');
  const description = labeledValue(input.text, ['岗位要求', '任职要求', '职位要求'])
    || (naturalGoal ? clean(input.text) : '');
  const retention = Number(labeledValue(input.text, ['保存期限', '材料保存期限']).match(/\d+/u)?.[0]);
  if (title) input.store.setJobTitle(title);
  if (description) input.store.setJobDescription(description);
  if ([7, 30, 90].includes(retention)) input.store.setRetentionDays(retention);
  if (/(?:我确认|确认)?已取得候选人.{0,12}(?:授权|同意)|候选人已授权|确认候选人已授权并选择材料/u.test(input.text)) {
    input.store.setConsentConfirmed(true);
  }
}

function resumeMissing(store: RecruitmentWorkspaceStore): string[] {
  const state = store.getSnapshot();
  return [
    ...(!state.jobTitle.trim() ? ['岗位名称'] : []),
    ...(!state.jobDescription.trim() ? ['岗位要求'] : []),
    ...(!state.consentConfirmed ? ['明确确认已取得候选人授权'] : []),
  ];
}

function screeningMessage(candidate: CandidateWorkspace): string {
  const evaluation = candidate.semanticEvaluation;
  if (!evaluation) {
    return `这份简历尚未获得全文模型分析：${clean(candidate.semanticError) || '请在右侧招聘工作台重试。'}系统不会用关键词命中结果代替智能分析。`;
  }
  const dimensions = evaluation.dimensions.map((dimension, index) => {
    const evidence = dimension.evidence.length
      ? dimension.evidence.map((entry) => `第 ${entry.line} 行：${clean(entry.quote, 300)}`).join('；')
      : '无可回查原文，本维度分数已受限';
    return `${index + 1}. **${dimension.label} ${dimension.score}**：${clean(dimension.assessment, 500)}\n   原文证据：${evidence}`;
  });
  return `候选人全文综合分析：**${evaluation.overallScore}/100**（证据覆盖 ${evaluation.evidenceCoverage}%）\n\n${clean(evaluation.summary, 800)}\n\n${dimensions.join('\n\n')}\n\n该分数是当前材料与当前岗位的贴合度，不是录用概率；最终招聘决定必须由招聘人员作出并复核原文。`;
}

function interviewKitMessage(candidate: CandidateWorkspace): string {
  if (!candidate.semanticEvaluation) return '请先完成该候选人的全文智能分析，再生成针对性面试问题。';
  const kit = generateInterviewKit(candidate.analysis, candidate.semanticEvaluation);
  if (kit.questions.length === 0) return '模型没有返回可用的针对性问题，请在右侧工作台重新分析。';
  const questions = kit.questions.slice(0, 8).map((question, index) => [
    `${index + 1}. **${clean(question.question, 500)}**`,
    `   - 提问原因：${clean(question.rationale, 500)}`,
    ...question.followUps.map((followUp) => `   - 追问：${clean(followUp, 300)}`),
    `   - 评价规则：${clean(question.rubric, 500)}`,
  ].join('\n'));
  return `结构化面试问题：\n\n${questions.join('\n\n')}\n\n问题来自证据不足项，不代表候选人已经具备或缺少相关能力。`;
}

function privacyMessage(store: RecruitmentWorkspaceStore): string {
  const state = store.getSnapshot();
  if (state.candidates.length === 0) {
    return `招聘共享工作区当前没有候选人材料。默认材料保存期限 ${state.retentionDays} 天，只有明确授权后才能导入。`;
  }
  const lines = state.candidates.slice(0, 10).map((candidate, index) => (
    `${index + 1}. ${clean(candidate.fileName, 200)}：保存期限 ${candidate.retentionDays} 天，截止 ${new Date(candidate.expiresAt).toLocaleDateString('zh-CN')}`
  ));
  return `招聘隐私与审计摘要：\n\n${lines.join('\n')}\n\n当前有 ${state.audits.length} 条审计记录。身份字段与评价输入隔离；清除材料需要独立强确认。`;
}

function createDraft(
  kind: RecruitmentActionKind,
  input: RecruitmentConversationInput,
  now: number,
  candidateId?: string,
): RecruitmentConversationDraft {
  return {
    id: `recruitment:${kind}:${crypto.randomUUID()}`,
    kind,
    sessionId: input.sessionId,
    accountId: input.accountId,
    ...(candidateId ? { candidateId } : {}),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + RECRUITMENT_DRAFT_TTL_MS,
  };
}

function isCancel(text: string): boolean {
  return /^(?:取消|不用了|放弃|不处理了)[。！!\s]*$/u.test(text.trim());
}

function resumeConfirm(text: string): boolean {
  return /^(?:确认选择简历|确认候选人已授权并选择材料)[。！!\s]*$/u.test(text.trim());
}

function audioConfirm(text: string): boolean {
  return /^确认选择面试录音[。！!\s]*$/u.test(text.trim());
}

function purgeConfirm(text: string): boolean {
  return /^确认删除候选人材料[。！!\s]*$/u.test(text.trim());
}

async function importResume(
  input: RecruitmentConversationInput,
  draft: RecruitmentConversationDraft,
  now: number,
): Promise<void> {
  const filePaths = (await input.selectFiles()).slice(0, 3);
  if (!filePaths.length) {
    input.postMessage('assistant', '你取消了文件选择，候选人材料尚未导入；草稿仍保留。');
    return;
  }
  const resumePaths = filePaths.filter((filePath) => RESUME_EXTENSIONS.has(extension(filePath)));
  const mediaPaths = filePaths.filter((filePath) => AUDIO_EXTENSIONS.has(extension(filePath)));
  if (!resumePaths.length && !mediaPaths.length) {
    throw new Error('请选择 PDF、DOCX、TXT、Markdown 简历，或常见音频/视频文件');
  }
  if (resumePaths.length > 1 || mediaPaths.length > 1) {
    throw new Error('对话入口一次处理一位候选人的一份简历和一份面试材料；批量分析请使用右侧智能招聘工作台');
  }
  const state = input.store.getSnapshot();
  const candidateId = `candidate:${crypto.randomUUID()}`;
  let extracted: ExtractedDocument | null = null;
  if (resumePaths[0]) {
    extracted = await input.extractDocument(resumePaths[0]);
    if (!clean(extracted.content)) throw new Error('简历中没有提取到可分析文字');
  }
  let transcriptText = '';
  let transcriptReport: CandidateWorkspace['transcriptReport'] = null;
  let transcriptWarning = '';
  let transcriptionModel = '';
  if (mediaPaths[0]) {
    const transcription = await input.transcribe(mediaPaths[0]);
    const rawTranscript = transcription.segments.map((segment) => (
      `[${timestamp(segment.startSeconds)}] ${clean(segment.speaker, 80)}：${clean(segment.text)}`
    )).join('\n');
    if (!rawTranscript.trim()) throw new Error('面试材料中没有提取到可分析的语音文字');
    transcriptText = analyzeCandidateResume({
      candidateId,
      resumeText: rawTranscript,
      jobDescription: state.jobDescription,
      now: new Date(now).toISOString(),
    }).redactedResume;
    transcriptWarning = clean(transcription.warning);
    transcriptionModel = clean(transcription.model, 100);
  }
  const analysis = analyzeCandidateResume({
    candidateId,
    resumeText: extracted?.content ?? transcriptText,
    jobDescription: state.jobDescription,
    now: new Date(now).toISOString(),
  });
  if (transcriptText) {
    transcriptReport = analyzeInterviewTranscript({
      transcript: transcriptText,
      redactedResume: extracted
        ? analysis.redactedResume
        : '当前候选人未提供简历，履历信息需要后续补充核实。',
      jobDescription: state.jobDescription,
    });
  }
  const semanticEvaluation = await input.analyzeResume({
    candidateId,
    jobTitle: state.jobTitle,
    jobDescription: state.jobDescription,
    redactedResume: extracted
      ? analysis.redactedResume
      : '当前候选人未提供简历，请只根据面试转写判断，并将缺少的履历信息列为待核实事项。',
    ...(transcriptText ? { interviewTranscript: transcriptText } : {}),
  });
  const candidate: CandidateWorkspace = {
    id: candidateId,
    fileName: clean(extracted?.fileName ?? mediaPaths[0]?.split(/[\\/]/u).at(-1) ?? '候选人材料', 300),
    consentAt: new Date(now).toISOString(),
    retentionDays: state.retentionDays,
    expiresAt: new Date(now + state.retentionDays * 86_400_000).toISOString(),
    analysis,
    semanticEvaluation,
    semanticError: '',
    semanticMaterials: extracted && transcriptText
      ? 'resume_interview'
      : transcriptText ? 'interview' : 'resume',
    jobTitleSnapshot: state.jobTitle,
    jobDescriptionSnapshot: state.jobDescription,
    transcriptText,
    transcriptReport,
    transcriptWarning,
    decision: null,
  };
  input.store.setCandidates((current) => [...current, candidate]);
  input.store.setActiveCandidateId(candidateId);
  // Consent is candidate-specific. Keeping the checkbox true would silently
  // reuse one person's authorization for the next imported resume.
  input.store.setConsentConfirmed(false);
  input.store.setAudits((current) => [makeRecruitmentAudit(
    candidateId,
    transcriptText && extracted ? 'resume_interview_analyzed' : transcriptText ? 'interview_only_analyzed' : 'resume_analyzed',
    extracted
      ? `已解析 ${clean(extracted.sourceFormat, 20).toUpperCase()} 简历${transcriptText ? `并使用 ${transcriptionModel} 转写面试材料` : ''}；身份字段与能力评价已分离，保存期限 ${state.retentionDays} 天。`
      : `未提供简历；已使用 ${transcriptionModel} 转写面试材料并建立候选人档案，履历信息标记为待核实，保存期限 ${state.retentionDays} 天。`,
    'system',
    `${semanticEvaluation.analysisVersion}/${semanticEvaluation.modelProvider}`,
  ), ...current]);
  input.registry.clear(draft.sessionId, draft.accountId);
  input.postMessage('assistant', `候选人档案已生成：${extracted && transcriptText ? '简历与面试材料已联合分析' : extracted ? '简历全文已分析' : '已根据面试材料分析，未提供的履历信息已标为待核实'}。当前材料贴合度 ${semanticEvaluation.overallScore}/100，证据覆盖 ${semanticEvaluation.evidenceCoverage}%。结果已同步到右侧智能招聘；每条能力判断可回查原文，手机号、邮箱等身份字段没有进入评价输入。`);
}

async function importAudio(
  input: RecruitmentConversationInput,
  draft: RecruitmentConversationDraft,
): Promise<void> {
  const candidate = input.store.getSnapshot().candidates.find((item) => item.id === draft.candidateId);
  if (!candidate) throw new Error('候选人已切换或材料已被清除，请重新发起音频分析');
  const [filePath] = await input.selectFiles();
  if (!filePath) {
    input.postMessage('assistant', '你取消了文件选择，面试录音尚未处理；草稿仍保留。');
    return;
  }
  if (!AUDIO_EXTENSIONS.has(extension(filePath))) throw new Error('请选择受支持的面试录音或视频文件');
  const result = await input.transcribe(filePath);
  const transcriptText = result.segments.map((segment) => (
    `[${timestamp(segment.startSeconds)}] ${clean(segment.speaker, 80)}：${clean(segment.text)}`
  )).join('\n');
  const state = input.store.getSnapshot();
  const transcriptReport = analyzeInterviewTranscript({
    transcript: transcriptText,
    redactedResume: candidate.analysis.redactedResume,
    jobDescription: state.jobDescription,
  });
  const semanticEvaluation = await input.analyzeResume({
    candidateId: candidate.id,
    jobTitle: state.jobTitle,
    jobDescription: state.jobDescription,
    redactedResume: candidate.analysis.redactedResume,
    interviewTranscript: transcriptText,
  });
  input.store.setCandidates((current) => current.map((item) => item.id === candidate.id ? {
    ...item,
    transcriptText,
    transcriptReport,
    transcriptWarning: clean(result.warning),
    semanticEvaluation,
    semanticError: '',
    semanticMaterials: 'resume_interview',
  } : item));
  input.store.setAudits((current) => [makeRecruitmentAudit(
    candidate.id,
    'interview_transcribed',
    `已使用 ${clean(result.model, 100)} 完成转写，并将面试回答与简历全文联合分析。`,
    'system',
    `${semanticEvaluation.analysisVersion}/${semanticEvaluation.modelProvider}`,
  ), ...current]);
  input.registry.clear(draft.sessionId, draft.accountId);
  input.postMessage('assistant', `面试材料已与简历联合分析：当前材料贴合度 ${semanticEvaluation.overallScore}/100，证据覆盖 ${semanticEvaluation.evidenceCoverage}%。候选人档案和针对性面试问题已经同步更新；只分析回答文字，不分析口音、音高、表情或情绪。`);
}

export class RecruitmentConversationDraftRegistry {
  private readonly drafts = new Map<string, RecruitmentConversationDraft>();
  private readonly running = new Set<string>();

  private key(sessionId: string, accountId: string): string {
    return `${accountId}:${sessionId}`;
  }

  get(sessionId: string, accountId: string, now: number = Date.now()): RecruitmentConversationDraft | null {
    const key = this.key(sessionId, accountId);
    const draft = this.drafts.get(key);
    if (!draft) return null;
    if (draft.sessionId !== sessionId || draft.accountId !== accountId || draft.expiresAt <= now) {
      this.drafts.delete(key);
      this.running.delete(key);
      return null;
    }
    return draft;
  }

  save(draft: RecruitmentConversationDraft): void {
    const key = this.key(draft.sessionId, draft.accountId);
    this.drafts.delete(key);
    this.drafts.set(key, draft);
    while (this.drafts.size > MAX_DRAFTS) {
      const oldest = this.drafts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.drafts.delete(oldest);
      this.running.delete(oldest);
    }
  }

  clear(sessionId: string, accountId: string): void {
    const key = this.key(sessionId, accountId);
    this.drafts.delete(key);
    this.running.delete(key);
  }

  summary(
    sessionId: string,
    accountId: string,
    store: RecruitmentWorkspaceStore,
    now: number = Date.now(),
  ): ConversationActionDraftSummary | null {
    const draft = this.get(sessionId, accountId, now);
    if (!draft) return null;
    const key = this.key(sessionId, accountId);
    const running = this.running.has(key);
    const missing = draft.kind === 'resume-import' ? resumeMissing(store) : [];
    const title = draft.kind === 'resume-import'
      ? '候选人材料分析'
      : draft.kind === 'audio-import' ? '面试录音分析' : '清除候选人材料';
    const confirmationText = draft.kind === 'resume-import'
      ? '确认候选人已授权并选择材料'
      : draft.kind === 'audio-import' ? '确认选择面试录音' : '确认删除候选人材料';
    return {
      id: draft.id,
      source: 'recruitment',
      title,
      phase: running ? 'submitting' : missing.length ? 'collecting' : 'awaiting_confirmation',
      updatedAt: draft.updatedAt,
      expiresAt: draft.expiresAt,
      missingFields: missing,
      ...(!running && missing.length === 0 ? { confirmationText } : {}),
    };
  }

  discard(id: string, sessionId: string, accountId: string, now: number = Date.now()): boolean {
    const draft = this.get(sessionId, accountId, now);
    const key = this.key(sessionId, accountId);
    if (!draft || draft.id !== id || this.running.has(key)) return false;
    this.clear(sessionId, accountId);
    return true;
  }

  begin(sessionId: string, accountId: string): boolean {
    const key = this.key(sessionId, accountId);
    if (this.running.has(key)) return false;
    this.running.add(key);
    return true;
  }

  finish(sessionId: string, accountId: string): void {
    this.running.delete(this.key(sessionId, accountId));
  }

  snapshot(accountId: string, now: number = Date.now()): RecruitmentConversationDraft[] {
    return [...this.drafts.values()].filter((draft) => {
      if (draft.expiresAt <= now) {
        this.clear(draft.sessionId, draft.accountId);
        return false;
      }
      return draft.accountId === accountId;
    });
  }

  restore(accountId: string, payload: unknown, now: number = Date.now()): number {
    if (!Array.isArray(payload)) return 0;
    let restored = 0;
    for (const raw of payload.slice(0, MAX_DRAFTS)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const draft = raw as Partial<RecruitmentConversationDraft>;
      if (
        typeof draft.id !== 'string'
        || !['resume-import', 'audio-import', 'purge-candidate'].includes(String(draft.kind))
        || typeof draft.sessionId !== 'string'
        || draft.sessionId.length > 500
        || draft.accountId !== accountId
        || typeof draft.createdAt !== 'number'
        || typeof draft.updatedAt !== 'number'
        || typeof draft.expiresAt !== 'number'
        || draft.expiresAt <= now
        || (draft.candidateId !== undefined && typeof draft.candidateId !== 'string')
      ) continue;
      this.save(draft as RecruitmentConversationDraft);
      restored += 1;
    }
    return restored;
  }
}

export async function handleRecruitmentConversation(
  input: RecruitmentConversationInput,
): Promise<boolean> {
  if (!input.enabled || !input.text.trim()) return false;
  const now = input.now?.() ?? Date.now();
  let draft = input.registry.get(input.sessionId, input.accountId, now);
  if (input.expectedDraftId && draft?.id !== input.expectedDraftId) {
    input.postMessage('assistant', '该招聘操作草稿已变化或过期，本次没有执行。请检查当前草稿后重新确认。');
    return true;
  }
  const intent = draft ? null : detectIntent(input.text);
  if (!draft && !intent) return false;
  input.postMessage('user', input.text.trim());

  if (draft && isCancel(input.text)) {
    input.registry.clear(input.sessionId, input.accountId);
    input.postMessage('assistant', '已取消本次招聘操作草稿，没有选择、上传或删除任何候选人材料。');
    return true;
  }

  if (!draft && intent === 'screening') {
    const candidate = input.store.activeCandidate();
    input.postMessage('assistant', candidate ? screeningMessage(candidate) : '请先导入并选择一份候选人简历。');
    return true;
  }
  if (!draft && intent === 'interview-kit') {
    const candidate = input.store.activeCandidate();
    input.postMessage('assistant', candidate ? interviewKitMessage(candidate) : '请先导入并选择一份候选人简历。');
    return true;
  }
  if (!draft && intent === 'privacy-audit') {
    input.postMessage('assistant', privacyMessage(input.store));
    return true;
  }

  if (!draft && intent === 'resume-import') {
    draft = createDraft('resume-import', input, now);
    input.registry.save(draft);
  } else if (!draft && intent === 'audio-import') {
    const candidate = input.store.activeCandidate();
    if (!candidate) {
      input.postMessage('assistant', '请先导入并选择一份候选人简历，再分析对应面试录音。');
      return true;
    }
    draft = createDraft('audio-import', input, now, candidate.id);
    input.registry.save(draft);
  } else if (!draft && intent === 'purge-candidate') {
    const candidate = input.store.activeCandidate();
    if (!candidate) {
      input.postMessage('assistant', '当前没有可清除的候选人材料。');
      return true;
    }
    draft = createDraft('purge-candidate', input, now, candidate.id);
    input.registry.save(draft);
  } else if (draft) {
    draft = { ...draft, updatedAt: now, expiresAt: now + RECRUITMENT_DRAFT_TTL_MS };
    input.registry.save(draft);
  }
  if (!draft) return false;

  try {
    if (draft.kind === 'resume-import') {
      applyResumeContext(input);
      const missing = resumeMissing(input.store);
      if (missing.length > 0) {
        const state = input.store.getSnapshot();
        const knownGoal = state.jobTitle && state.jobDescription
          ? `Otto 已理解你要招聘“${state.jobTitle}”。`
          : '';
        input.postMessage('assistant', `${knownGoal}开始分析前只需补充：${missing.join('、')}。若已取得授权，回复“确认候选人已授权并选择材料”，随后直接选择简历、面试视频，或两者一起选择。`);
        return true;
      }
      if (!resumeConfirm(input.text)) {
        const state = input.store.getSnapshot();
        input.postMessage('assistant', `招聘目标“${state.jobTitle}”已理解，材料保存 ${state.retentionDays} 天。回复“确认候选人已授权并选择材料”后可直接选择简历、面试视频，或两者一起选择。`);
        return true;
      }
      if (!input.registry.begin(input.sessionId, input.accountId)) {
        input.postMessage('assistant', '简历选择或分析正在进行，请勿重复操作。');
        return true;
      }
      try {
        await importResume(input, draft, now);
      } finally {
        input.registry.finish(input.sessionId, input.accountId);
      }
      return true;
    }
    if (draft.kind === 'audio-import') {
      if (!audioConfirm(input.text)) {
        input.postMessage('assistant', '回复“确认选择面试录音”后由你亲自选择文件。Otto只分析回答文字，不使用口音、音高、表情或情绪作招聘判断。');
        return true;
      }
      if (!input.registry.begin(input.sessionId, input.accountId)) {
        input.postMessage('assistant', '面试录音选择或分析正在进行，请勿重复操作。');
        return true;
      }
      try {
        await importAudio(input, draft);
      } finally {
        input.registry.finish(input.sessionId, input.accountId);
      }
      return true;
    }
    if (!purgeConfirm(input.text)) {
      input.postMessage('assistant', '这会清除当前候选人的简历、转写和分析结果，仅保留不含原始材料的审计事件。若确定，请回复“确认删除候选人材料”。');
      return true;
    }
    if (!input.registry.begin(input.sessionId, input.accountId)) {
      input.postMessage('assistant', '候选人材料正在清除，请勿重复操作。');
      return true;
    }
    try {
      const candidate = input.store.getSnapshot().candidates.find((item) => item.id === draft.candidateId);
      if (!candidate) throw new Error('候选人已切换或材料已被清除');
      input.store.setCandidates((current) => current.filter((item) => item.id !== candidate.id));
      input.store.setActiveCandidateId((current) => current === candidate.id ? '' : current);
      input.store.setAudits((current) => [makeRecruitmentAudit(
        candidate.id,
        'candidate_purged',
        '招聘人员通过对话强确认清除候选人简历、转写和分析结果。',
        'human',
        null,
      ), ...current]);
      input.registry.clear(draft.sessionId, draft.accountId);
      input.postMessage('assistant', '当前候选人材料已清除；仅保留不含简历和录音原文的审计事件。');
    } finally {
      input.registry.finish(input.sessionId, input.accountId);
    }
  } catch (error) {
    input.postMessage('assistant', `招聘操作未完成：${error instanceof Error ? error.message : String(error)}。草稿已保留，可修正后重试或回复“取消”。`);
  }
  return true;
}
