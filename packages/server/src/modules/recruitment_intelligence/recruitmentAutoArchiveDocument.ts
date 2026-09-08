/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { RecruitmentSharedJob, RecruitmentArchivedCandidate } from './recruitmentJobs.js';
import type { RecruitmentIncomingMaterial } from './recruitmentIntake.js';
import { recruitmentArchiveDocumentToken, type RecruitmentArchiveReceipt } from './recruitmentAutoArchive.js';
import { captureRecruitmentAssessmentContext } from './recruitmentAssessment.js';
import { sanitizeRecruitmentModelInput } from './recruitmentSemanticModel.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from './recruitmentSemantic.js';

/** Produces the existing v1 desktop archive shape; contract-tested with the desktop parser. */
export async function projectRecruitmentArchive(job: RecruitmentSharedJob, item: RecruitmentIncomingMaterial, at: string): Promise<RecruitmentSharedJob> {
  const config = job.autoArchive!; const result = item.analysis!; const evaluation = result.evaluation;
  const source = item.material.source;
  const key = recruitmentArchiveDocumentToken([job.id, source.sourceId, source.sourceRecordId]);
  const binding = config.bindings.find((entry) => entry.sourceKey === key);
  const record = (receipt: RecruitmentArchiveReceipt, candidates = job.candidates, bindings = config.bindings): RecruitmentSharedJob => {
    const incomingMaterials = job.incomingMaterials!.map((entry) => entry.id === item.id ? { ...entry, archive: receipt } : entry);
    if (Buffer.byteLength(JSON.stringify([candidates, incomingMaterials]), 'utf8') > 5_900_000) return { ...job, autoArchive: { ...config, enabled: false, message: '岗位空间不足，自动入档已暂停；已有材料和结果未丢弃，请整理后重新开启' } };
    return { ...job, candidates, incomingMaterials, autoArchive: { ...config, bindings, lastRunAt: at, message: receipt.message } };
  };
  const review = (message: string): RecruitmentSharedJob => record({ status: 'needs_review', at, message, ...(binding ? { candidateId: binding.candidateId } : {}) });
  const redactedResume = sanitizeRecruitmentModelInput(item.material.material.text);
  const expected = await captureRecruitmentAssessmentContext({ candidateId: item.id, jobTitle: job.title, jobDescription: job.description, redactedResume }, evaluation?.assessmentContext?.modelId ?? '');
  if (item.material.requisitionId !== job.id || item.material.material.completeness !== 'full_text' || result.status !== 'completed'
    || !evaluation?.execution || evaluation.execution.runId !== result.runId || evaluation.analysisVersion !== RECRUITMENT_SEMANTIC_ANALYSIS_VERSION
    || result.redactedResume !== redactedResume || JSON.stringify(expected) !== JSON.stringify(evaluation.assessmentContext)
    || !Number.isFinite(Date.parse(item.material.retrievedAt))) return review('分析与当前岗位、材料或规则不一致，请复核；未创建或覆盖正式档案');
  let prior: RecruitmentArchivedCandidate | undefined;
  if (binding) {
    prior = job.candidates.find((entry) => entry.id === binding.candidateId);
    if (!prior || Date.parse(prior.expiresAt) <= Date.parse(at)) return review('原档案已删除或到期，不会自动恢复；新材料仍保留在待处理箱');
  }
  // A matching manually managed source is not permission to replace that person's dossier.
  try {
    if (!binding && job.candidates.some((entry) => {
      const doc = JSON.parse(entry.document);
      return doc.sources?.some((s: { providerId?: string; sourceRecordId?: string }) => s.providerId === source.sourceId && s.sourceRecordId === source.sourceRecordId);
    })) return review('同一来源已存在人工档案，请人工合并；没有新增重复候选人');
  } catch { return review('已有档案格式无法安全核对，请人工检查后再入档'); }
  let previous: ReturnType<typeof makeDocument> | undefined;
  if (prior && binding) {
    try { previous = JSON.parse(prior.document); } catch { return review('已有档案无法读取，未覆盖'); }
    if (recruitmentArchiveDocumentToken(previous) !== binding.documentToken) return review('已有同事修改、面试或人工记录，请复核新简历；原档案未覆盖');
    if (binding.runId === result.runId) return record({ status: 'unchanged', at, candidateId: prior.id, message: '该分析已正式入档，本次没有新增档案或模型调用' });
    if (Date.parse(item.material.retrievedAt) <= Date.parse(binding.retrievedAt)) return review('材料获取时间不晚于已入档版本，未用旧材料覆盖新档案');
    if ((previous?.analysisHistory.length ?? 0) >= 20 || (previous?.sourceHistory.length ?? 0) >= 20) return review('分析历史达到保留上限，请先整理；未覆盖或删除旧版本');
  }
  if (!prior && (job.candidates.length >= 100 || config.bindings.length >= 500)) return review('候选人或来源跟踪数量达到上限，请先整理岗位');
  const candidateId = prior?.id ?? `candidate:auto:${key.slice(0, 32)}`;
  // Consent has a bounded window. Later updates never silently extend an existing dossier's retention.
  const document = makeDocument(candidateId, prior, previous);
  const serialized = JSON.stringify(document);
  if (serialized.length > 1_000_000) return review('完整档案与历史超过单人容量，结果仍在待处理箱，请人工整理');
  const candidate = { id: candidateId, expiresAt: document.expiresAt, document: serialized, personId: prior?.personId ?? `person:${randomUUID()}` };
  const receipt: RecruitmentArchiveReceipt = { status: prior ? 'updated' : 'created', at, candidateId,
    message: prior ? '新简历与分析已更新正式档案，旧版可回查；建议复核变化' : '已自动创建正式候选人档案，待招聘人员查看；结论仅有简历自述支持' };
  const nextBinding = { sourceKey: key, candidateId, documentToken: recruitmentArchiveDocumentToken(document), retrievedAt: item.material.retrievedAt, runId: result.runId };
  return record(receipt, prior ? job.candidates.map((entry) => entry.id === prior.id ? candidate : entry) : [...job.candidates, candidate], [...config.bindings.filter((entry) => entry.sourceKey !== key), nextBinding]);

  function makeDocument(candidateId: string, prior?: RecruitmentArchivedCandidate, previous?: {
    consentAt: string; sources: unknown[]; analysisHistory: unknown[]; sourceHistory: unknown[]; sourceMaterial: unknown; semanticEvaluation: unknown; decision: unknown; archiveAudits: unknown[];
  }) {
    const fileName = item.material.material.fileName || '后台接收简历'; const mode = prior ? 'updated' as const : 'created' as const;
    return {
      id: candidateId, fileName, pipelineStage: 'new' as const,
      sources: previous?.sources ?? [{ id: `source:${randomUUID()}`, providerId: source.sourceId, providerLabel: source.sourceLabel, acquisitionMode: item.material.acquisitionMode,
        authorizationStatus: 'provider_contract', importedAt: at, observedAt: item.material.retrievedAt, sourceRecordId: source.sourceRecordId, sourceUrl: source.profileUrl, originalFileName: fileName }],
      consentAt: previous?.consentAt ?? config.confirmedAt, retentionDays: previous ? Math.round((Date.parse(prior!.expiresAt) - Date.parse(previous.consentAt)) / 86_400_000) : config.retentionDays,
      expiresAt: prior?.expiresAt ?? config.expiresAt,
      analysis: { candidateId, identity: {}, redactedResume, skills: [], timeline: [], experiences: [], projects: [], findings: [], questions: [], engineVersion: 'otto-background-semantic-archive-v1', createdAt: at },
      semanticEvaluation: evaluation!, semanticError: '', semanticMaterials: 'resume' as const, jobTitleSnapshot: job.title, jobDescriptionSnapshot: job.description,
      transcriptText: '', transcriptReport: null, transcriptWarning: '', workSampleText: '', decision: null,
      sourceMaterial: item.material,
      analysisHistory: [{ evaluation: evaluation!, jobTitle: job.title, jobDescription: job.description, resumeText: redactedResume, transcriptText: '', workSampleText: '', fileName, reuseCount: 0, lastRequest: evaluation!.execution!.requestedAt }, ...previous?.analysisHistory ?? []],
      sourceHistory: previous ? [{ material: previous.sourceMaterial, evaluation: previous.semanticEvaluation, decision: previous.decision }, ...previous.sourceHistory] : [],
      backgroundArchive: { itemId: item.id, archivedAt: at, mode, message: prior ? '新简历已自动更新，请复核变化' : '后台自动建档，待查看' },
      archiveVersion: 1,
      archiveAudits: [{ id: `recruitment-audit:${randomUUID()}`, candidateId, action: prior ? 'background_archive_updated' : 'background_archive_created', actorType: 'system', modelVersion: evaluation!.analysisVersion,
        detail: '依据岗位负责人事先授权自动正式入档，未新增模型调用或作出招聘决定', createdAt: at }, ...previous?.archiveAudits ?? []],
    };
  }
}
