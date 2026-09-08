/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import { RecruitmentJobError, type RecruitmentArchivedCandidate, type RecruitmentSharedJob } from './recruitmentJobs.js';

export type RecruitmentPipelineStage = 'new' | 'reviewing' | 'interview' | 'follow_up' | 'closed';
export interface RecruitmentRelatedApplication {
  jobId: string; jobTitle: string; jobRevision: number; candidateId: string; fileName: string;
  reason: 'linked' | 'contact_pair' | 'source_record' | 'conflict'; stage: RecruitmentPipelineStage;
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function document(candidate: RecruitmentArchivedCandidate): RecordValue {
  try { return record(JSON.parse(candidate.document)); } catch { return {}; }
}
export function recruitmentPipelineStage(value: unknown): RecruitmentPipelineStage {
  return ['new', 'reviewing', 'interview', 'follow_up', 'closed'].includes(String(value)) ? value as RecruitmentPipelineStage : 'new';
}
function anchors(candidate: RecruitmentArchivedCandidate) {
  const data = document(candidate);
  const identity = record(record(data.analysis).identity);
  const email = text(identity.email).trim().toLowerCase();
  let phone = text(identity.phone).trim().replace(/[\s()+-]/gu, '');
  if (/^(?:0086|86)1\d{10}$/u.test(phone)) phone = phone.slice(-11);
  const source = record(record(data.sourceMaterial).source);
  const sourceKey = text(source.sourceId) && text(source.sourceRecordId) ? JSON.stringify([source.sourceId, source.sourceRecordId]) : '';
  return { email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/u.test(email) ? email : '', phone: /^\d{7,15}$/u.test(phone) ? phone : '', sourceKey };
}
/** Matching is a review hint, not verified identity or permission to merge records. */
export function recruitmentIdentityMatch(a: RecruitmentArchivedCandidate, b: RecruitmentArchivedCandidate): RecruitmentRelatedApplication['reason'] | null {
  if (a.personId && a.personId === b.personId) return 'linked';
  const left = anchors(a);
  const right = anchors(b);
  if (left.sourceKey && left.sourceKey === right.sourceKey) {
    if ((left.email && right.email && left.email !== right.email) || (left.phone && right.phone && left.phone !== right.phone)) return 'conflict';
    return 'source_record';
  }
  return left.email && left.phone && left.email === right.email && left.phone === right.phone ? 'contact_pair' : null;
}
export function relatedRecruitmentApplication(job: RecruitmentSharedJob, candidate: RecruitmentArchivedCandidate, reason: RecruitmentRelatedApplication['reason']): RecruitmentRelatedApplication {
  const data = document(candidate);
  return { jobId: job.id, jobTitle: job.title, jobRevision: job.revision, candidateId: candidate.id, fileName: text(data.fileName).slice(0, 500), reason, stage: recruitmentPipelineStage(data.pipelineStage) };
}
/** Copy only material fields; no old-job scores, decisions, questions or assessment-derived context. */
export function copyRecruitmentCandidate(source: RecruitmentArchivedCandidate, target: RecruitmentSharedJob, now: string): RecruitmentArchivedCandidate {
  const data = document(source);
  const analysis = record(data.analysis);
  if (!source.personId || data.archiveVersion !== 1 || typeof analysis.redactedResume !== 'string' || !analysis.redactedResume.trim()) throw new RecruitmentJobError(400, '请先使用新版客户端保存含简历正文的来源岗位，再复用材料');
  const id = `candidate:${randomUUID()}`;
  const copied = {
    id, fileName: data.fileName, sources: data.sources, consentAt: data.consentAt, retentionDays: data.retentionDays, expiresAt: source.expiresAt,
    analysis: { candidateId: id, identity: analysis.identity, redactedResume: analysis.redactedResume, skills: analysis.skills, timeline: analysis.timeline, experiences: analysis.experiences, projects: analysis.projects, findings: [], questions: [], engineVersion: analysis.engineVersion, createdAt: now },
    semanticEvaluation: null, semanticError: '材料已复用，尚未按当前岗位分析。请在分析区启动本岗位分析。',
    jobTitleSnapshot: target.title, jobDescriptionSnapshot: target.description,
    transcriptText: text(data.transcriptText), transcriptReport: null, transcriptWarning: '',
    workSampleText: text(data.workSampleText), workSampleFileName: text(data.workSampleFileName),
    decision: null, sourceMaterial: data.sourceMaterial, pipelineStage: 'new',
    sourceHistory: Array.isArray(data.sourceHistory) ? data.sourceHistory.filter((item) => record(item).material).map((item) => ({ material: record(item).material, evaluation: null, decision: null })) : [],
    archiveVersion: 1, archiveAudits: [{ id: `recruitment-audit:${randomUUID()}`, candidateId: id, action: 'cross_job_material_copy', actorType: 'human', modelVersion: null, detail: '经人工确认复用企业已有材料；保留原保存期限，未沿用其他岗位的评价或决定。', createdAt: now }],
  };
  return { id, expiresAt: source.expiresAt, personId: source.personId, document: JSON.stringify(copied) };
}
