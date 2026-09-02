/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  CandidateResumeAnalysis,
  HiringDecisionAudit,
  InterviewTranscriptAnalysis,
} from './recruitmentAnalysis.js';
import type { RecruitmentSemanticEvaluation } from '../main/recruitmentSemantic.js';

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
  id: string;
  fileName: string;
  consentAt: string;
  retentionDays: number;
  expiresAt: string;
  analysis: CandidateResumeAnalysis;
  semanticEvaluation?: RecruitmentSemanticEvaluation | null;
  semanticError?: string;
  semanticMaterials?: 'resume' | 'interview' | 'resume_interview';
  jobTitleSnapshot?: string;
  jobDescriptionSnapshot?: string;
  transcriptText: string;
  transcriptReport: InterviewTranscriptAnalysis | null;
  transcriptWarning: string;
  decision: HiringDecisionAudit | null;
}

export interface RecruitmentWorkspaceState {
  jobTitle: string;
  jobDescription: string;
  consentConfirmed: boolean;
  retentionDays: number;
  candidates: CandidateWorkspace[];
  activeCandidateId: string;
  audits: RecruitmentAuditEvent[];
}

type StateUpdater<T> = T | ((current: T) => T);

const EMPTY_STATE: RecruitmentWorkspaceState = {
  jobTitle: '',
  jobDescription: '',
  consentConfirmed: false,
  retentionDays: 30,
  candidates: [],
  activeCandidateId: '',
  audits: [],
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
  private state: RecruitmentWorkspaceState = { ...EMPTY_STATE };
  private readonly listeners = new Set<() => void>();

  constructor(readonly scopeKey = 'default') {}

  getSnapshot = (): RecruitmentWorkspaceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<RecruitmentWorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  setJobTitle(value: StateUpdater<string>): void {
    this.update({ jobTitle: resolveUpdate(this.state.jobTitle, value) });
  }

  setJobDescription(value: StateUpdater<string>): void {
    this.update({ jobDescription: resolveUpdate(this.state.jobDescription, value) });
  }

  setConsentConfirmed(value: StateUpdater<boolean>): void {
    this.update({ consentConfirmed: resolveUpdate(this.state.consentConfirmed, value) });
  }

  setRetentionDays(value: StateUpdater<number>): void {
    const next = resolveUpdate(this.state.retentionDays, value);
    this.update({ retentionDays: [7, 30, 90].includes(next) ? next : 30 });
  }

  setCandidates(value: StateUpdater<CandidateWorkspace[]>): void {
    this.update({ candidates: resolveUpdate(this.state.candidates, value) });
  }

  setActiveCandidateId(value: StateUpdater<string>): void {
    this.update({ activeCandidateId: resolveUpdate(this.state.activeCandidateId, value) });
  }

  setAudits(value: StateUpdater<RecruitmentAuditEvent[]>): void {
    this.update({ audits: resolveUpdate(this.state.audits, value) });
  }

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
