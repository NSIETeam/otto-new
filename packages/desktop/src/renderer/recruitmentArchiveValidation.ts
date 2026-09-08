/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { CandidateWorkspace, RecruitmentAuditEvent } from './recruitmentWorkspaceStore.js';

// Archive documents cross a trust boundary: a coworker or an older client may
// have written them. Check nested renderable fields before replacing live state.
type Check = (value: unknown) => boolean;
const str: Check = (v) => typeof v === 'string' && v.length <= 1_000_000;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const bool: Check = (v) => typeof v === 'boolean';
const tokenCount: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const fingerprint: Check = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const boundedString = (min: number, max: number): Check => (v) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const values = (...allowed: unknown[]): Check => (v) => allowed.includes(v);
const optional = (check: Check): Check => (v) => v === undefined || check(v);
const nullable = (check: Check): Check => (v) => v === null || check(v);
const array = (check: Check, max = 10_000): Check => (v) => Array.isArray(v) && v.length <= max && v.every(check);
const object = (fields: Record<string, Check>): Check => (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v) && Object.entries(fields).every(([key, check]) => check((v as Record<string, unknown>)[key])));
const strings = array(str);
const evidence = object({ line: num, quote: str, source: optional(values('resume', 'interview', 'work_sample')) });
const decision = nullable(object({ id: str, candidateId: str, reviewerId: str, actorType: values('human'), decision: values('shortlist', 'hold', 'reject'), rationale: str, modelVersion: values(null), createdAt: str }));
const question = object({ criterion: str, question: str, rationale: str, followUps: strings, goodSignals: strings, concernSignals: strings });
const evaluation = nullable(object({
  summary: str, overallScore: num, matchLevel: values('strong', 'good', 'partial', 'weak', 'insufficient'), evidenceCoverage: num,
  dimensions: array(object({ id: values('core_capability', 'experience_depth', 'delivery_impact', 'role_scope', 'transferability'), label: str, score: num, assessment: str, evidence: array(evidence), uncertainties: strings })),
  hardRequirements: array(object({ requirement: str, status: values('met', 'partially_met', 'not_met', 'not_demonstrated', 'unclear'), explanation: str, evidence: array(evidence) })),
  strengths: strings, risks: strings, missingInformation: strings, interviewQuestions: array(question),
  evidenceGraph: optional(array(object({ criterion: str, status: values('verified', 'partially_verified', 'contradicted', 'untested', 'unclear'), assessment: str, evidence: array(evidence), gaps: strings, nextQuestion: str }))),
  workSample: optional(nullable(object({ title: str, scenario: str, timeboxMinutes: num, deliverables: strings, constraints: strings, rubric: array(object({ criterion: str, weight: num, observableSignals: strings })), followUpQuestions: strings }))),
  enterpriseContextUsed: optional(bool), analysisVersion: str, modelProvider: str, inputTokens: num, outputTokens: num, createdAt: str,
  coordination: optional(object({ claimId: boundedString(1, 200), status: values('recorded', 'unconfirmed'), message: boundedString(1, 1000) })),
  execution: optional(object({ runId: boundedString(1, 200), requestId: optional(boundedString(1, 200)), disposition: values('executed', 'reused'),
    requestedAt: (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)), inputFingerprint: fingerprint,
    inputTokens: nullable(tokenCount), outputTokens: nullable(tokenCount) })),
  assessmentContext: optional(object({ schemaVersion: values(1), jobFingerprint: fingerprint, materialFingerprint: fingerprint, enterpriseFingerprint: fingerprint,
    materialScope: (v) => Array.isArray(v) && v.length > 0 && v.length <= 3 && new Set(v).size === v.length && v.every(values('resume', 'interview', 'work_sample')), modelId: boundedString(1, 500) })),
}));
const source = object({ id: str, providerId: str, providerLabel: str, acquisitionMode: values('manual_upload', 'candidate_submission', 'employee_referral', 'authorized_api', 'authorized_mcp'), authorizationStatus: values('confirmed', 'provider_contract', 'candidate_submitted'), importedAt: str, observedAt: str, sourceRecordId: optional(str), sourceUrl: optional(str), originalFileName: optional(str) });
const material = object({
  runId: str, requisitionId: str, canonicalId: str,
  source: object({ sourceId: str, sourceLabel: str, sourceRecordId: str, profileUrl: optional(str) }),
  acquisitionMode: values('authorized_api', 'authorized_mcp'),
  material: object({ sourceRecordId: str, fileName: optional(str), text: str, completeness: values('full_text', 'partial', 'unavailable'), reason: optional(str),
    attachment: optional(object({ sha256: (v) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v), bytes: (v) => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 8 * 1024 * 1024, format: values('pdf', 'txt'), pages: optional((v) => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 40), extractorVersion: values('otto-resume-v1') })) }),
  contentHash: str, retrievedAt: str,
});
const audit = object({ id: str, candidateId: str, action: str, actorType: values('human', 'system'), modelVersion: nullable(str), detail: str, createdAt: str });
const date: Check = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const intakeClaim = object({ id: boundedString(1, 200), requestId: boundedString(1, 200), actorAccountId: boundedString(1, 200), candidateId: boundedString(1, 200),
  status: values('claimed', 'started', 'completed', 'unknown'), createdAt: date, expiresAt: date, finishedAt: optional(date),
  scopeToken: fingerprint, headerToken: fingerprint, message: boundedString(1, 1000) });
export const validRecruitmentIntake = optional(object({
  enabled: bool, generation: str, actorAccountId: str, sourceId: values('workable'), intervalMinutes: values(30, 60, 360, 1440), retentionDays: values(7, 30, 90), maxMaterials: values(5, 10, 20),
  confirmedAt: date, nextRunAt: date, scopeToken: fingerprint, headerToken: fingerprint, cursor: optional(str), lease: optional(object({ id: str, until: date })),
  seen: array(object({ id: fingerprint, expiresAt: date }), 500),
  runs: array(object({ id: str, startedAt: date, finishedAt: date, status: values('completed', 'partial', 'paused', 'failed'), received: tokenCount, unchanged: tokenCount, failed: tokenCount, hasMore: bool, modelInvoked: values(false), message: str }), 10),
}));
export const validRecruitmentBackground = optional(object({ enabled: bool, generation: str, actorAccountId: str, confirmedAt: date, scopeToken: fingerprint, headerToken: fingerprint,
  modelVersion: str, modelId: str, dailyRequestLimit: tokenCount, dailyReservedTokenLimit: tokenCount, message: str,
  usage: array(object({ day: str, requests: tokenCount, reservedTokens: tokenCount, inputTokens: tokenCount, outputTokens: tokenCount, unknownRequests: tokenCount }), 9),
  organizationUsage: optional(object({ day: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(v), checkedAt: date,
    dailyRequests: tokenCount, dailyReservedTokens: tokenCount, requests: tokenCount, reservedTokens: tokenCount, inputTokens: tokenCount, outputTokens: tokenCount, unknownRequests: tokenCount })),
  pending: optional(object({ id: str, itemId: str, until: date, day: str })),
}));
export const validRecruitmentAutoArchive = optional(object({ enabled: bool, generation: str, actorAccountId: str, confirmedAt: date, expiresAt: date,
  retentionDays: values(7, 30, 90), scopeToken: fingerprint, headerToken: fingerprint, message: str, lastRunAt: optional(date),
  bindings: array(object({ sourceKey: fingerprint, candidateId: str, documentToken: fingerprint, retrievedAt: date, runId: str }), 500),
}));
export const validRecruitmentInbox = optional(array(object({ id: fingerprint, receivedAt: date, expiresAt: date, material,
  archive: optional(object({ status: values('created', 'updated', 'unchanged', 'needs_review'), at: date, message: str, candidateId: optional(str) })),
  manualAnalysis: optional(intakeClaim), manualAnalysisHistory: optional(array(intakeClaim, 10)),
  analysis: optional(object({ status: values('completed', 'unknown'), runId: str, attemptedAt: date, message: str, inputFingerprint: fingerprint, modelVersion: str, redactedResume: str, evaluation: optional(evaluation), trigger: optional(values('background', 'manual')), requestedBy: optional(boundedString(1, 200)) })),
}), 100));
const candidateShape = object({
  backgroundArchive: optional(object({ itemId: fingerprint, archivedAt: date, mode: values('created', 'updated'), message: str })),
  id: str, fileName: str, sources: array(source, 100), consentAt: str, retentionDays: values(7, 30, 90), expiresAt: str,
  pipelineStage: optional(values('new', 'reviewing', 'interview', 'follow_up', 'closed')),
  analysis: object({
    candidateId: str, identity: object({ name: optional(str), phone: optional(str), email: optional(str), gender: optional(str), age: optional(str), birthDate: optional(str) }),
    redactedResume: str, skills: strings, timeline: strings, experiences: strings, projects: strings, questions: strings, engineVersion: str, createdAt: str,
    findings: array(object({ id: str, criterion: str, requirement: values('required', 'preferred'), status: values('supported', 'uncertain', 'missing'), evidence: array(evidence), matchedTerms: strings, missingTerms: strings, rule: str, confidence: num })),
  }),
  semanticEvaluation: optional(evaluation), semanticError: optional(str), semanticMaterials: optional(values('resume', 'interview', 'resume_interview')),
  analysisHistory: optional(array(object({ evaluation: (v) => v !== null && evaluation(v), jobTitle: str, jobDescription: str,
    resumeText: str, transcriptText: str, workSampleText: str, fileName: str, reuseCount: tokenCount, lastRequest: str }), 20)),
  jobTitleSnapshot: optional(str), jobDescriptionSnapshot: optional(str), transcriptText: str, transcriptWarning: str,
  transcriptReport: nullable(object({
    segments: array(object({ speaker: str, startSeconds: num, endSeconds: optional(num), text: str })),
    starEvidence: array(object({ segmentIndex: num, timestamp: num, situation: bool, task: bool, action: bool, result: bool, quote: str })),
    knowledgeEvidence: array(object({ criterion: str, status: values('supported', 'uncertain', 'missing'), evidence: array(object({ timestamp: num, quote: str })), matchedTerms: strings, missingTerms: strings, rule: str, confidence: num })),
    incompleteAnswers: strings, inconsistencies: strings, contentNotice: str, engineVersion: str,
  })),
  workSampleText: optional(str), workSampleFileName: optional(str), decision,
  evidenceReviews: optional(array(object({ binding: fingerprint, criterion: boundedString(1, 1000), reviewerId: boundedString(1, 500), actorType: values('human'), outcome: values('supported', 'contradicted', 'inconclusive'), rationale: boundedString(5, 1000), createdAt: (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) }), 100)),
  sourceMaterial: optional(material), sourceAnalysisContext: optional(str),
  sourceHistory: optional(array(object({ material, evaluation, decision }), 20)),
  archiveAudits: optional(array(audit, 1000)), archiveVersion: optional(values(1)),
});

export function parseRecruitmentCandidateDocument(document: string): { candidate: CandidateWorkspace; audits: RecruitmentAuditEvent[] } {
  let data: unknown;
  try { if (document.length > 1_000_000) throw new Error(); data = JSON.parse(document); } catch { throw new Error('候选人档案格式无效或超过大小限制'); }
  if (!candidateShape(data)) throw new Error('候选人档案格式不受当前版本支持，请升级客户端；当前工作台未改动');
  const { archiveAudits, archiveVersion: _version, ...candidate } = data as CandidateWorkspace & { archiveAudits?: RecruitmentAuditEvent[]; archiveVersion?: number };
  if (candidate.analysis.candidateId !== candidate.id || archiveAudits?.some((event) => event.candidateId !== candidate.id)) throw new Error('候选人档案格式中的身份关联不一致');
  if (!Number.isFinite(Date.parse(candidate.expiresAt)) || !Number.isFinite(Date.parse(candidate.consentAt))) throw new Error('候选人档案格式中的保存期限无效');
  return { candidate, audits: archiveAudits ?? [] };
}
