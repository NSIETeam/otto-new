/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi, afterEach } from 'vitest';
import * as iteration from './iterationReview.js';
import {
  assessTestPilot,
  PILOT_STOP_EVENTS,
  type TestPilotInput,
} from './testPilotReadiness.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');
function fixture(): TestPilotInput {
  return {
    pilotId: 'test-pilot-001',
    candidate: {
      sourceFingerprint: hash(1),
      version: '1.9.14-test.1',
      clientSha256: hash(2),
      serverChanged: false,
      serverSha256: null,
    },
    evaluation: null,
    humanReview: {
      reviewer: 'test-reviewer',
      evidenceHash: hash(9),
      approved: true,
    },
    targets: [
      {
        accountId: 'qa-account-1',
        tenantId: 'qa-tenant-1',
        testOnlyEvidenceHash: hash(8),
      },
    ],
    confinement: {
      dedicatedClientProfile: true,
      testApiOnly: true,
      manualInstallOnly: true,
      dispatchFenceRehearsalHash: hash(7),
    },
    rollback: {
      clientSha256: hash(3),
      serverSha256: null,
      clientBackupSha256: hash(4),
      serverBackupSha256: null,
      owner: 'qa-operator',
      runbookHash: hash(5),
      rehearsal: {
        passed: true,
        candidateClientSha256: hash(2),
        rollbackClientSha256: hash(3),
        candidateServerSha256: null,
        rollbackServerSha256: null,
        clientBackupSha256: hash(4),
        serverBackupSha256: null,
        restoredDataVerified: true,
        evidenceHash: hash(6),
      },
    },
    monitoring: { complete: true, evidenceHash: hash(10) },
    events: [],
    previous: null,
  };
}
// These unit fixtures mock an already-reviewed report, NOT real model executions.
// The real dependency's scoring and fixture refusal are covered by iterationReview tests.
function reviewedFixture() {
  const input = fixture();
  input.evaluation = {
    regression: { plan: { afterSource: hash(1) } },
  } as iteration.IterationInput;
  vi.spyOn(iteration, 'reviewIteration');
  vi.mocked(iteration.reviewIteration, { partial: true }).mockReturnValue({
    admission: 'manual_pilot_review',
    blockers: [],
    safetyPassed: true,
    holdoutEligible: true,
  });
  return input;
}
afterEach(() => vi.restoreAllMocks());

it('missing real data blocks test pilot approval despite all other declarations', () => {
  const result = assessTestPilot(fixture());
  expect(result.state).toBe('blocked');
  expect(result.blockers).toContain('real_comparison_and_holdout_required');
  expect(result.productionReleaseAllowed).toBe(false);
});
it('even complete input only permits a separate test-pilot approval decision, never rollout', () => {
  const result = assessTestPilot(reviewedFixture());
  expect(result.state).toBe('ready_for_test_pilot_approval');
  expect(result.automaticExpansionAllowed).toBe(false);
  expect(result.productionReleaseAllowed).toBe(false);
  expect(result.executionPerformed).toBe(false);
});
it.each(PILOT_STOP_EVENTS)(
  'a suspected %s immediately stops admission without waiting for confirmation',
  (kind) => {
    const input = reviewedFixture();
    input.events.push({
      id: 'event-1',
      kind,
      suspected: true,
      evidenceHash: null,
    });
    const result = assessTestPilot(input);
    expect(result.state).toBe('stopped');
    expect(result.stopLatched).toBe(true);
    expect(result.actions).toContain('freeze_new_dispatch_and_expansion');
  },
);
it('a latched stop cannot be cleared by passing tests, removing events or changing candidate version', () => {
  const input = reviewedFixture();
  input.previous = { pilotId: input.pilotId, stopLatched: true };
  expect(assessTestPilot(input).state).toBe('stopped');
  input.candidate.version = '1.9.14-test.2';
  expect(assessTestPilot(input).state).toBe('stopped');
});
it('rejects state from another pilot instead of silently resetting the stop', () => {
  const input = fixture();
  input.previous = { pilotId: 'another-pilot', stopLatched: true };
  expect(() => assessTestPilot(input)).toThrow(/pilot/i);
});
it.each(['empty', 'wildcard', 'duplicate'] as const)(
  'blocks %s target scopes',
  (kind) => {
    const input = reviewedFixture();
    if (kind === 'empty') input.targets = [];
    if (kind === 'wildcard') input.targets[0].tenantId = '*';
    if (kind === 'duplicate') input.targets.push({ ...input.targets[0] });
    expect(assessTestPilot(input).blockers).toContain(
      'exact_test_account_tenant_pairs_required',
    );
  },
);
it.each(['profile', 'api', 'channel', 'fence'] as const)(
  'blocks unprepared %s isolation',
  (kind) => {
    const input = reviewedFixture();
    if (kind === 'profile') input.confinement.dedicatedClientProfile = false;
    if (kind === 'api') input.confinement.testApiOnly = false;
    if (kind === 'channel') input.confinement.manualInstallOnly = false;
    if (kind === 'fence') input.confinement.dispatchFenceRehearsalHash = null;
    expect(assessTestPilot(input).blockers).toContain(
      'test_isolation_and_stop_fence_required',
    );
  },
);
it('binds evaluation to the exact candidate and refuses unreviewed or blocked evidence', () => {
  const input = reviewedFixture();
  input.candidate.sourceFingerprint = hash(90);
  input.humanReview.approved = false;
  expect(assessTestPilot(input).blockers).toContain(
    'candidate_differs_from_evaluated_source',
  );
  expect(assessTestPilot(input).blockers).toContain(
    'independent_human_review_required',
  );
  vi.mocked(iteration.reviewIteration, { partial: true }).mockReturnValue({
    admission: 'blocked',
    blockers: ['missing_real_observations'],
  });
  expect(assessTestPilot(input).blockers).toContain(
    'evaluation:missing_real_observations',
  );
});
it.each(['unbuilt', 'stale', 'same', 'backup', 'unrehearsed'] as const)(
  'blocks %s rollback preparation',
  (kind) => {
    const input = reviewedFixture();
    if (kind === 'unbuilt') input.candidate.clientSha256 = null;
    if (kind === 'stale')
      input.rollback.rehearsal!.candidateClientSha256 = hash(90);
    if (kind === 'same')
      input.rollback.clientSha256 = input.candidate.clientSha256;
    if (kind === 'backup') input.rollback.clientBackupSha256 = null;
    if (kind === 'unrehearsed') input.rollback.rehearsal = null;
    expect(assessTestPilot(input).state).toBe('blocked');
  },
);
it('a server change requires paired server backup, rollback and matching rehearsal hashes', () => {
  const input = reviewedFixture();
  input.candidate.serverChanged = true;
  input.candidate.serverSha256 = hash(11);
  expect(assessTestPilot(input).blockers).toContain(
    'rollback_not_rehearsed_for_exact_artifacts',
  );
  input.rollback.serverSha256 = hash(12);
  input.rollback.serverBackupSha256 = hash(13);
  Object.assign(input.rollback.rehearsal!, {
    candidateServerSha256: hash(11),
    rollbackServerSha256: hash(12),
    serverBackupSha256: hash(13),
  });
  expect(assessTestPilot(input).state).toBe('ready_for_test_pilot_approval');
});
it('missing monitoring blocks admission and requires checking unknown side effects', () => {
  const input = reviewedFixture();
  input.monitoring.complete = false;
  const result = assessTestPilot(input);
  expect(result.state).toBe('blocked');
  expect(result.actions).toContain(
    'reconcile_in_flight_effects_without_replay',
  );
});
