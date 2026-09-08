/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { RecruitmentMaterialResult } from 'otto-server';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from '../main/recruitmentSemantic.js';
import type { RecruitmentSemanticAnalysisInput, RecruitmentSemanticEvaluation } from '../main/recruitmentSemantic.js';
import { analyzeCandidateResume } from './recruitmentAnalysis.js';
import { assertRecruitmentHistoryCapacity } from './recruitmentAnalysisHistory.js';
import { captureRecruitmentAssessmentContext } from '../main/recruitmentAssessment.js';
import { sanitizeRecruitmentModelInput } from 'otto-server/recruitment';
import { withRecruitmentIntakeContext } from './recruitmentIntakeContext.js';
import { makeRecruitmentAudit, type CandidateWorkspace, type RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';

export interface RecruitmentSourceImportInput {
  store: RecruitmentWorkspaceStore;
  canonicalId: string;
  sourceId: string;
  /** Read an already authorized shared-job inbox, without repeating the platform request. */
  incomingMaterialId?: string;
  getMaterial(input: { runId: string; requisitionId: string; canonicalId: string; sourceId: string }): Promise<RecruitmentMaterialResult>;
  analyzeResume(input: RecruitmentSemanticAnalysisInput): Promise<RecruitmentSemanticEvaluation>;
  enterpriseContext?: string;
  signal?: AbortSignal;
}

export interface RecruitmentSourceImportResult {
  candidate: CandidateWorkspace;
  status: 'analyzed' | 'unchanged' | 'incomplete' | 'analysis_failed';
}

const pending = new WeakMap<RecruitmentWorkspaceStore, Map<string, Promise<RecruitmentSourceImportResult>>>();

/** Shared by chat and the workbench; duplicate clicks share one read/model operation. */
export async function importRecruitmentSourceCandidate(input: RecruitmentSourceImportInput): Promise<RecruitmentSourceImportResult> {
  const state = input.store.getSnapshot();
  const key = JSON.stringify([input.store.getWorkspaceEpoch(), state.sharedJob?.id, input.incomingMaterialId, state.sourceSearch?.result.runId, input.canonicalId, input.sourceId, input.enterpriseContext ?? '']);
  let operations = pending.get(input.store);
  if (!operations) { operations = new Map(); pending.set(input.store, operations); }
  const existing = operations.get(key);
  if (existing) return existing;
  const operation = importCandidate(input);
  operations.set(key, operation);
  try { return await operation; } finally { operations.delete(key); }
}

async function importCandidate(input: RecruitmentSourceImportInput): Promise<RecruitmentSourceImportResult> {
  const { store } = input;
  const state = store.getSnapshot();
  const inbox = input.incomingMaterialId ? state.sharedJob?.base?.incomingMaterials?.find((item) => item.id === input.incomingMaterialId) : undefined;
  if (input.incomingMaterialId && (!inbox || Date.parse(inbox.expiresAt) <= Date.now() || inbox.material.requisitionId !== state.sharedJob?.id)) throw new Error('待处理材料已到期、已移除或不属于当前共享岗位');
  if (inbox?.archive && inbox.archive.status !== 'needs_review') throw new Error('此结果已正式入档，请刷新并查看候选人列表，不必重复导入');
  if (inbox && !inbox.archive && inbox.analysis?.status === 'completed' && state.sharedJob?.base?.autoArchive?.enabled) throw new Error('此结果正在等待自动入档，请稍后刷新；暂停自动入档后才可改为手动导入');
  const search = inbox ? { requisitionId: inbox.material.requisitionId, result: { runId: inbox.material.runId, candidates: [{ canonicalId: inbox.material.canonicalId, sources: [inbox.material.source] }] } } : state.sourceSearch;
  const epoch = store.getWorkspaceEpoch();
  if (input.signal?.aborted) throw new Error('已取消本次材料导入');
  if (!state.consentConfirmed) throw new Error('请先确认已取得本次候选人材料的分析与限期保存授权');
  if (!search || !state.jobDescription.trim()) throw new Error('请先按当前招聘目标检索候选人');
  const hit = search.result.candidates.find((candidate) => candidate.canonicalId === input.canonicalId);
  const source = hit?.sources.find((entry) => entry.sourceId === input.sourceId);
  if (!hit || !source) throw new Error('候选人不在本次检索结果中');
  const matchesSource = (candidate: CandidateWorkspace): boolean => (
    candidate.jobTitleSnapshot === state.jobTitle && candidate.jobDescriptionSnapshot === state.jobDescription
    && candidate.sources.some((entry) => entry.providerId === source.sourceId && entry.sourceRecordId === source.sourceRecordId)
  );
  const beforeRead = state.candidates.find(matchesSource);
  const assertCurrent = (): void => {
    if (input.signal?.aborted) throw new Error('已取消本次材料导入');
    const current = store.getSnapshot();
    const sameOrigin = inbox ? current.sharedJob?.id === state.sharedJob?.id && current.sharedJob?.sync?.scopeToken === state.sharedJob?.sync?.scopeToken
      && Date.parse(inbox.expiresAt) > Date.now() && current.sharedJob?.base?.incomingMaterials?.some((item) => item.id === inbox.id) : current.sourceSearch === search;
    if (!sameOrigin || store.getWorkspaceEpoch() !== epoch || current.jobTitle !== state.jobTitle || current.jobDescription !== state.jobDescription
      || !current.consentConfirmed || current.retentionDays !== state.retentionDays) {
      throw new Error('账号、招聘目标、授权或检索结果已变化，本次结果未写回，请重新操作');
    }
  };
  const material = inbox?.material ?? await input.getMaterial({
    runId: search.result.runId, requisitionId: search.requisitionId,
    canonicalId: input.canonicalId, sourceId: input.sourceId,
  });
  assertCurrent();
  if (beforeRead && !store.getSnapshot().candidates.includes(beforeRead)) {
    throw new Error('候选人材料已变化或已清除，本次读取结果未写回');
  }
  if (material.runId !== search.result.runId || material.requisitionId !== search.requisitionId
    || material.canonicalId !== hit.canonicalId || material.source.sourceId !== source.sourceId
    || material.source.sourceRecordId !== source.sourceRecordId || material.material.sourceRecordId !== source.sourceRecordId
    || typeof material.material.text !== 'string' || material.material.text.length > 80_000
    || !['full_text', 'partial', 'unavailable'].includes(material.material.completeness)) {
    throw new Error('返回材料与当前候选人不匹配或超过分析上限，未进行模型分析');
  }
  store.purgeExpired();
  const previous = store.getSnapshot().candidates.find(matchesSource);
  const background = inbox?.analysis;
  if (inbox?.manualAnalysis) throw new Error('此材料已由同事认领或处理，请刷新共享档案；结果未知时需岗位创建者或管理员核对用量后确认重新处理');
  if (inbox && ((!background && state.sharedJob?.base?.backgroundAnalysis?.enabled) || state.sharedJob?.base?.backgroundAnalysis?.pending?.itemId === inbox.id)) throw new Error('此材料由后台分析任务处理，请等待完成并刷新；不要同时发起另一轮付费分析');
  if (background?.status === 'completed') {
    const evaluation = background.evaluation;
    const expected = await captureRecruitmentAssessmentContext({ candidateId: input.canonicalId, jobTitle: state.jobTitle, jobDescription: state.jobDescription, redactedResume: sanitizeRecruitmentModelInput(material.material.text) }, evaluation?.assessmentContext?.modelId ?? '');
    assertCurrent();
    if (!evaluation?.execution || evaluation.execution.runId !== background.runId || evaluation.analysisVersion !== RECRUITMENT_SEMANTIC_ANALYSIS_VERSION
      || (state.sharedJob?.base?.backgroundAnalysis && background.modelVersion !== state.sharedJob.base.backgroundAnalysis.modelVersion)
      || JSON.stringify(expected) !== JSON.stringify(evaluation.assessmentContext) || background.redactedResume !== sanitizeRecruitmentModelInput(material.material.text)
      || input.enterpriseContext?.trim() || previous?.transcriptText?.trim() || previous?.workSampleText?.trim()) throw new Error('后台结果仅适用于原岗位与简历；当前岗位、企业标准或面试材料不一致，请在工作台手动重新分析，不会自动付费重试');
  }
  assertRecruitmentHistoryCapacity(previous);
  const analysisContext = JSON.stringify([
    RECRUITMENT_SEMANTIC_ANALYSIS_VERSION,
    state.jobTitle, state.jobDescription, input.enterpriseContext ?? '',
    previous?.transcriptText ?? '', previous?.workSampleText ?? '',
  ]);
  const sameMaterial = previous?.sourceMaterial?.contentHash === material.contentHash
    && previous?.sourceMaterial?.material.text === material.material.text
    && previous?.sourceMaterial?.material.completeness === material.material.completeness;
  const changedAttachment = previous?.sourceMaterial?.material.attachment?.sha256 !== material.material.attachment?.sha256;
  const currentRules = previous?.semanticEvaluation?.analysisVersion === RECRUITMENT_SEMANTIC_ANALYSIS_VERSION;
  const preserveVersion = previous?.sourceMaterial && (!sameMaterial || changedAttachment || previous.sourceAnalysisContext !== analysisContext || (previous.semanticEvaluation && !currentRules));
  if (preserveVersion && (previous?.sourceHistory?.length ?? 0) >= 20) {
    throw new Error('该候选人材料已达到 20 个历史版本，请先导出并整理历史材料');
  }
  // Reuse is decided at the trusted model boundary, which knows current model/route settings.
  if (!previous && store.getSnapshot().candidates.length >= 100) throw new Error('当前工作台已达到 100 位候选人上限，请先整理现有材料');
  const id = previous?.id ?? `candidate:${crypto.randomUUID()}`;
  const importedAt = new Date().toISOString();
  const consentAt = previous?.consentAt ?? importedAt;
  const complete = material.material.completeness === 'full_text' && material.material.text.trim().length >= 20;
  let candidate: CandidateWorkspace = {
    ...previous, id, fileName: material.material.fileName || '来源候选人资料',
    sources: previous?.sources ?? [{
      id: `source:${crypto.randomUUID()}`, providerId: source.sourceId, providerLabel: source.sourceLabel,
      acquisitionMode: material.acquisitionMode, authorizationStatus: 'provider_contract',
      importedAt, observedAt: material.retrievedAt, sourceRecordId: source.sourceRecordId,
      sourceUrl: source.profileUrl, originalFileName: material.material.fileName,
    }],
    consentAt, retentionDays: previous?.retentionDays ?? state.retentionDays,
    expiresAt: previous?.expiresAt ?? new Date(Date.now() + state.retentionDays * 86_400_000).toISOString(),
    analysis: { ...analyzeCandidateResume({ candidateId: id, resumeText: material.material.text, jobDescription: state.jobDescription }), ...(background?.status === 'completed' ? { redactedResume: background.redactedResume } : {}) },
    semanticEvaluation: null,
    semanticError: complete ? '材料已入档，正在进行全文分析。' : material.material.completeness === 'unavailable'
      ? '来源没有提供可分析正文，请手动补充简历。' : '仅获得部分资料，尚未进行简历全文分析，请补充完整简历。',
    semanticMaterials: undefined, jobTitleSnapshot: state.jobTitle, jobDescriptionSnapshot: state.jobDescription,
    transcriptText: previous?.transcriptText ?? '', transcriptReport: previous?.transcriptReport ?? null,
    transcriptWarning: previous?.transcriptWarning ?? '', decision: null,
    sourceMaterial: material, sourceAnalysisContext: analysisContext,
    sourceHistory: preserveVersion ? [
      { material: previous!.sourceMaterial!, evaluation: previous!.semanticEvaluation ?? null, decision: previous!.decision },
      ...(previous!.sourceHistory ?? []),
    ] : previous?.sourceHistory ?? [],
  };
  store.setCandidates((items) => previous ? items.map((entry) => entry.id === id ? candidate : entry) : [...items, candidate]);
  candidate = store.getSnapshot().candidates.find((entry) => entry.id === id)!;
  store.setActiveCandidateId(id);
  store.setAudits((events) => [makeRecruitmentAudit(id, 'source_material_imported',
    complete ? '来源材料已入档，保留来源与正文，开始全文分析。' : '来源材料不足，未调用模型。'), ...events]);
  if (!complete) return { candidate, status: 'incomplete' };
  let evaluation: RecruitmentSemanticEvaluation | null = null;
  let semanticError = '';
  try {
    if (background?.status === 'completed' && background.evaluation?.execution) {
      evaluation = { ...background.evaluation, execution: { ...background.evaluation.execution, disposition: 'reused', requestedAt: new Date().toISOString() } };
    } else if (background) {
      semanticError = '后台调用结果未知，已保留材料；本次未重新调用模型。请核对运行记录与厂商用量后手动决定是否重新分析。';
    } else evaluation = await input.analyzeResume(withRecruitmentIntakeContext(store, {
      candidateId: id, jobTitle: state.jobTitle, jobDescription: state.jobDescription,
      redactedResume: candidate.analysis.redactedResume,
      ...(candidate.transcriptText ? { interviewTranscript: candidate.transcriptText } : {}),
      ...(candidate.workSampleText ? { workSampleArtifact: candidate.workSampleText } : {}),
      ...(input.enterpriseContext ? { enterpriseContext: input.enterpriseContext } : {}),
    }, inbox?.id));
  } catch { semanticError = inbox
    ? '共享材料分析未确认完成；材料已保留。请刷新待处理箱并核对原客户端、共享保存状态与厂商用量，勿直接重复付费分析。'
    : '模型分析未完成；材料和已有历史已保留，可重试。失败请求可能已消耗 Token，用量需以厂商记录为准。'; }
  assertCurrent();
  if (store.getSnapshot().candidates.find((entry) => entry.id === id) !== candidate) {
    throw new Error('候选人材料已变化或已清除，本次分析结果未写回');
  }
  const updated: CandidateWorkspace = {
    ...candidate, semanticEvaluation: evaluation, semanticError,
    decision: evaluation?.execution?.runId && evaluation.execution.runId === previous?.semanticEvaluation?.execution?.runId && sameMaterial
      && previous.sourceAnalysisContext === analysisContext ? previous.decision : null,
    semanticMaterials: evaluation ? (candidate.transcriptText ? 'resume_interview' : 'resume') : undefined,
  };
  store.setCandidates((items) => items.map((entry) => entry.id === id ? updated : entry));
  store.setAudits((events) => [makeRecruitmentAudit(id, evaluation ? 'source_semantic_analyzed' : 'source_semantic_failed',
    evaluation?.execution?.disposition === 'reused' ? '已复用相同输入与模型配置的结果，本次没有新增模型调用。'
      : evaluation ? '已按当前岗位阅读全文；可在对话和工作台继续查看证据与面试问题。' : semanticError), ...events]);
  return { candidate: store.getSnapshot().candidates.find((entry) => entry.id === id)!, status: evaluation?.execution?.disposition === 'reused' ? 'unchanged' : evaluation ? 'analyzed' : 'analysis_failed' };
}
