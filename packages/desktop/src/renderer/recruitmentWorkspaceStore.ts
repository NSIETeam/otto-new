/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  CandidateResumeAnalysis,
  HiringDecisionAudit,
  InterviewTranscriptAnalysis,
} from './recruitmentAnalysis.js';
import type { RecruitmentSemanticEvaluation } from '../main/recruitmentSemantic.js';
import type { RecruitmentCandidateSource } from './recruitmentSources.js';
import type { RecruitmentGatewaySearchResult, RecruitmentMaterialResult, RecruitmentSharedJob, RecruitmentSyncMetadata } from 'otto-server';
import { retainRecruitmentAnalysisHistory, type RecruitmentAnalysisRevision } from './recruitmentAnalysisHistory.js';

export interface RecruitmentSourceSearchState {
  requisitionId: string;
  jobTitle: string;
  jobDescription: string;
  result: RecruitmentGatewaySearchResult;
}

export interface RecruitmentAuditEvent {
  id: string;
  candidateId: string;
  action: string;
  actorType: 'human' | 'system';
  modelVersion: string | null;
  detail: string;
  createdAt: string;
}

export interface CandidateWorkspace {
  backgroundArchive?: { itemId: string; archivedAt: string; mode: 'created' | 'updated'; message: string };
  id: string;
  fileName: string;
  pipelineStage?: 'new' | 'reviewing' | 'interview' | 'follow_up' | 'closed';
  sources: RecruitmentCandidateSource[];
  consentAt: string;
  retentionDays: number;
  expiresAt: string;
  analysis: CandidateResumeAnalysis;
  semanticEvaluation?: RecruitmentSemanticEvaluation | null;
  analysisHistory?: RecruitmentAnalysisRevision[];
  semanticError?: string;
  semanticMaterials?: 'resume' | 'interview' | 'resume_interview';
  jobTitleSnapshot?: string;
  jobDescriptionSnapshot?: string;
  transcriptText: string;
  transcriptReport: InterviewTranscriptAnalysis | null;
  transcriptWarning: string;
  workSampleText?: string;
  workSampleFileName?: string;
  decision: HiringDecisionAudit | null;
  evidenceReviews?: Array<import('./recruitmentAssessment.js').RecruitmentEvidenceReview>;
  sourceMaterial?: RecruitmentMaterialResult;
  sourceAnalysisContext?: string;
  sourceHistory?: Array<{
    material: RecruitmentMaterialResult;
    evaluation: RecruitmentSemanticEvaluation | null;
    decision: HiringDecisionAudit | null;
  }>;
}

export interface RecruitmentWorkspaceState {
  sharedJob: { id: string; revision: number; savedFingerprint: string; base?: RecruitmentSharedJob; sync?: RecruitmentSyncMetadata; canManage?: boolean } | null;
  jobTitle: string;
  jobDescription: string;
  consentConfirmed: boolean;
  retentionDays: number;
  candidates: CandidateWorkspace[];
  activeCandidateId: string;
  audits: RecruitmentAuditEvent[];
  sourceSearch: RecruitmentSourceSearchState | null;
}

type StateUpdater<T> = T | ((current: T) => T);

const EMPTY_STATE: RecruitmentWorkspaceState = {
  sharedJob: null,
  jobTitle: '',
  jobDescription: '',
  consentConfirmed: false,
  retentionDays: 30,
  candidates: [],
  activeCandidateId: '',
  audits: [],
  sourceSearch: null,
};

function resolveUpdate<T>(current: T, update: StateUpdater<T>): T {
  return typeof update === 'function' ? (update as (value: T) => T)(current) : update;
}

export function makeRecruitmentAudit(
  candidateId: string,
  action: string,
  detail: string,
  actorType: RecruitmentAuditEvent['actorType'] = 'system',
  modelVersion: string | null = null,
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

export class RecruitmentWorkspaceStore {
  private workspaceEpoch = 0;
  private sourceJobIdentity: { fingerprint: string; id: string } | undefined;
  private state: RecruitmentWorkspaceState = { ...EMPTY_STATE };
  private readonly listeners = new Set<() => void>();

  constructor(readonly scopeKey = 'default') {}

  getSnapshot = (): RecruitmentWorkspaceState => this.state;
  getWorkspaceEpoch = (): number => this.workspaceEpoch;

  /** Both dialogue and cards use the same saved job binding; local drafts stay local. */
  getSourceRequisitionId = (): string => {
    if (this.state.sharedJob) return this.state.sharedJob.id;
    const fingerprint = JSON.stringify([this.workspaceEpoch, this.state.jobTitle, this.state.jobDescription]);
    if (this.sourceJobIdentity?.fingerprint !== fingerprint) this.sourceJobIdentity = { fingerprint, id: `job-${crypto.randomUUID()}` };
    return this.sourceJobIdentity.id;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<RecruitmentWorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  setJobTitle(value: StateUpdater<string>): void {
    const jobTitle = resolveUpdate(this.state.jobTitle, value);
    this.update({ jobTitle, ...(jobTitle !== this.state.jobTitle ? { sourceSearch: null } : {}) });
  }

  setJobDescription(value: StateUpdater<string>): void {
    const jobDescription = resolveUpdate(this.state.jobDescription, value);
    this.update({ jobDescription, ...(jobDescription !== this.state.jobDescription ? { sourceSearch: null } : {}) });
  }

  setSourceSearch(sourceSearch: RecruitmentSourceSearchState | null, expectedWorkspaceEpoch?: number): void {
    if (sourceSearch && expectedWorkspaceEpoch !== undefined && (expectedWorkspaceEpoch !== this.workspaceEpoch || sourceSearch.requisitionId !== this.getSourceRequisitionId())) {
      throw new Error('岗位已切换，已丢弃旧岗位的检索结果，请重新检索');
    }
    if (sourceSearch && (sourceSearch.jobTitle !== this.state.jobTitle || sourceSearch.jobDescription !== this.state.jobDescription)) {
      throw new Error('招聘目标已变化，请重新检索');
    }
    this.update({ sourceSearch });
  }

  setConsentConfirmed(value: StateUpdater<boolean>): void {
    this.update({ consentConfirmed: resolveUpdate(this.state.consentConfirmed, value) });
  }

  setRetentionDays(value: StateUpdater<number>): void {
    const next = resolveUpdate(this.state.retentionDays, value);
    this.update({ retentionDays: [7, 30, 90].includes(next) ? next : 30 });
  }

  setCandidates(value: StateUpdater<CandidateWorkspace[]>): void {
    const previous = new Map(this.state.candidates.map((candidate) => [candidate.id, candidate]));
    const candidates = resolveUpdate(this.state.candidates, value).map((candidate) => retainRecruitmentAnalysisHistory(previous.get(candidate.id), candidate));
    this.update({ candidates });
  }

  setActiveCandidateId(value: StateUpdater<string>): void {
    this.update({ activeCandidateId: resolveUpdate(this.state.activeCandidateId, value) });
  }

  setAudits(value: StateUpdater<RecruitmentAuditEvent[]>): void {
    this.update({ audits: resolveUpdate(this.state.audits, value) });
  }

  setSharedJob(sharedJob: RecruitmentWorkspaceState['sharedJob']): void { this.update({ sharedJob }); }

  /** Acknowledgements merge atomically without resetting the user's model consent or open selection. */
  applyArchiveUpdate(patch: Pick<RecruitmentWorkspaceState, 'jobTitle' | 'jobDescription' | 'candidates' | 'audits' | 'sharedJob'>): void {
    this.update({ ...patch, activeCandidateId: patch.candidates.some((item) => item.id === this.state.activeCandidateId) ? this.state.activeCandidateId : patch.candidates[0]?.id ?? '',
      ...(patch.jobTitle !== this.state.jobTitle || patch.jobDescription !== this.state.jobDescription ? { sourceSearch: null } : {}) });
  }

  restoreSharedJob(id: string, revision: number, jobTitle: string, jobDescription: string, candidates: CandidateWorkspace[], audits: RecruitmentAuditEvent[]): void {
    this.workspaceEpoch += 1;
    this.update({ ...EMPTY_STATE, jobTitle, jobDescription, candidates, audits, activeCandidateId: candidates[0]?.id ?? '', sharedJob: { id, revision, savedFingerprint: '' } });
  }

  resetWorkspace(): void { this.workspaceEpoch += 1; this.update({ ...EMPTY_STATE }); }

  activeCandidate(): CandidateWorkspace | null {
    return this.state.candidates.find((candidate) => candidate.id === this.state.activeCandidateId) ?? null;
  }

  purgeExpired(now = Date.now()): CandidateWorkspace[] {
    const expired = this.state.candidates.filter((candidate) => Date.parse(candidate.expiresAt) <= now);
    if (expired.length === 0) return [];
    const expiredIds = new Set(expired.map((candidate) => candidate.id));
    const audits = expired.map((candidate) => makeRecruitmentAudit(
      candidate.id,
      'retention_expired',
      `达到 ${candidate.retentionDays} 天保存期限，候选人材料已从当前工作台清除。`,
    ));
    this.update({
      candidates: this.state.candidates.filter((candidate) => !expiredIds.has(candidate.id)),
      activeCandidateId: expiredIds.has(this.state.activeCandidateId) ? '' : this.state.activeCandidateId,
      audits: [...audits, ...this.state.audits],
    });
    return expired;
  }
}
