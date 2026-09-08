/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';

import type {
  RecruitmentCandidateView,
  RecruitmentGatewaySearchRequest,
  RecruitmentGatewaySearchResult,
  RecruitmentSearchRunRecord,
} from './recruitmentSourceGateway.js';

export interface RecruitmentSourceSyncInput
  extends Omit<RecruitmentGatewaySearchRequest, 'signal'> {
  actorIsAdmin: boolean;
  signal?: AbortSignal;
}

export type RecruitmentSourceSyncResult =
  | { status: 'disabled'; changed: false; modelInvoked: false }
  | {
      status: 'completed';
      changed: boolean;
      modelInvoked: boolean;
      search: RecruitmentGatewaySearchResult;
    };

function stableCandidate(candidate: RecruitmentCandidateView): unknown {
  const evidence = Object.fromEntries(
    Object.entries(candidate.fieldEvidence)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entries]) => [
        field,
        entries
          .map(({ observedAt: _observedAt, ...entry }) => entry)
          .sort((left, right) =>
            `${left.sourceId}\0${left.sourceRecordId}\0${left.value}`.localeCompare(
              `${right.sourceId}\0${right.sourceRecordId}\0${right.value}`,
            ),
          ),
      ]),
  );
  return {
    canonicalId: candidate.canonicalId,
    displayName: candidate.displayName,
    headline: candidate.headline ?? '',
    location: candidate.location ?? '',
    identityKeys: [...candidate.identityKeys].sort(),
    sources: candidate.sources
      .map(({ sourceLabel: _sourceLabel, ...source }) => source)
      .sort((left, right) =>
        `${left.sourceId}\0${left.sourceRecordId}`.localeCompare(
          `${right.sourceId}\0${right.sourceRecordId}`,
        ),
      ),
    evidence,
  };
}

export function recruitmentCandidateSetFingerprint(
  candidates: readonly RecruitmentCandidateView[],
): string {
  const normalized = candidates
    .map(stableCandidate)
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createHash('sha256')
    .update(JSON.stringify(normalized), 'utf8')
    .digest('hex');
}

/** @deprecated Summary-only integration harness. Production scheduling and material intake use RecruitmentIntakeWorker in recruitmentIntake.ts. */
export function createRecruitmentSourceSyncService(options: {
  gateway: {
    search(input: RecruitmentGatewaySearchRequest): Promise<RecruitmentGatewaySearchResult>;
  };
  isEnabled(input: {
    organizationId: string;
    requisitionId: string;
  }): Promise<boolean>;
  previousRuns(
    organizationId: string,
    requisitionId: string,
    limit: number,
  ): Promise<RecruitmentSearchRunRecord[]>;
  analyzeChanges?(input: {
    organizationId: string;
    actorAccountId: string;
    requisitionId: string;
    query: string;
    previous: RecruitmentSearchRunRecord | null;
    current: RecruitmentGatewaySearchResult;
  }): Promise<void>;
}) {
  return {
    async run(input: RecruitmentSourceSyncInput): Promise<RecruitmentSourceSyncResult> {
      if (!input.actorIsAdmin)
        throw new Error('recruitment source synchronization requires an administrator');
      const enabled = await options.isEnabled({
        organizationId: input.organizationId,
        requisitionId: input.requisitionId,
      });
      if (!enabled)
        return { status: 'disabled', changed: false, modelInvoked: false };
      const [previous] = await options.previousRuns(
        input.organizationId,
        input.requisitionId,
        1,
      );
      const search = await options.gateway.search({
        organizationId: input.organizationId,
        actorAccountId: input.actorAccountId,
        requisitionId: input.requisitionId,
        query: input.query,
        sourceIds: input.sourceIds,
        cursors: input.cursors,
        limitPerSource: input.limitPerSource,
        signal: input.signal,
      });
      const changed =
        !previous ||
        recruitmentCandidateSetFingerprint(previous.candidates) !==
          recruitmentCandidateSetFingerprint(search.candidates);
      if (changed && options.analyzeChanges) {
        await options.analyzeChanges({
          organizationId: input.organizationId,
          actorAccountId: input.actorAccountId,
          requisitionId: input.requisitionId,
          query: input.query,
          previous: previous ?? null,
          current: search,
        });
      }
      return {
        status: 'completed',
        changed,
        modelInvoked: changed && Boolean(options.analyzeChanges),
        search,
      };
    },
  };
}
