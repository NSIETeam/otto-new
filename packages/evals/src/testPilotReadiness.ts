/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { reviewIteration, type IterationInput } from './iterationReview.js';

export const PILOT_STOP_EVENTS = [
  'unauthorized_access',
  'duplicate_send',
  'duplicate_deploy',
  'critical_false_delivery',
] as const;
export interface TestPilotInput {
  pilotId: string;
  candidate: {
    sourceFingerprint: string;
    version: string | null;
    clientSha256: string | null;
    serverChanged: boolean;
    serverSha256: string | null;
  };
  evaluation: IterationInput | null;
  humanReview: {
    approved: boolean;
    reviewer: string | null;
    evidenceHash: string | null;
  };
  /** Exact pairs, not a Cartesian product of unrelated account/tenant lists. */
  targets: Array<{
    accountId: string;
    tenantId: string;
    testOnlyEvidenceHash: string | null;
  }>;
  confinement: {
    dedicatedClientProfile: boolean;
    testApiOnly: boolean;
    manualInstallOnly: boolean;
    dispatchFenceRehearsalHash: string | null;
  };
  rollback: {
    clientSha256: string | null;
    serverSha256: string | null;
    clientBackupSha256: string | null;
    serverBackupSha256: string | null;
    owner: string | null;
    runbookHash: string | null;
    rehearsal: {
      passed: boolean;
      candidateClientSha256: string | null;
      rollbackClientSha256: string | null;
      candidateServerSha256: string | null;
      rollbackServerSha256: string | null;
      clientBackupSha256: string | null;
      serverBackupSha256: string | null;
      restoredDataVerified: boolean;
      evidenceHash: string | null;
    } | null;
  };
  monitoring: { complete: boolean; evidenceHash: string | null };
  events: Array<{
    id: string;
    kind: (typeof PILOT_STOP_EVENTS)[number];
    suspected: boolean;
    evidenceHash: string | null;
  }>;
  /** Supplied by the trusted append-only pilot controller, never the model. */
  previous: { pilotId: string; stopLatched: boolean } | null;
}
const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f\d]{64}$/u.test(v);
const exactId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z\d][a-z\d_.@-]{0,159}$/iu.test(v);
const named = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 200;

/** Pure offline readiness review. No installation, dispatch, tenant mutation or
 * production kill switch lives here. The future pilot controller must persist
 * the stop latch and enforce the whitelist/fence before each new side effect.
 * A readiness result never substitutes for that integration or human authority.
 */
export function assessTestPilot(input: TestPilotInput) {
  if (
    !exactId(input.pilotId) ||
    (input.previous &&
      (input.previous.pilotId !== input.pilotId ||
        typeof input.previous.stopLatched !== 'boolean'))
  )
    throw new Error('Invalid/mismatched pilot history');
  if (
    new Set(input.events.map((e) => e.id)).size !== input.events.length ||
    input.events.some(
      (e) =>
        !exactId(e.id) ||
        !PILOT_STOP_EVENTS.includes(e.kind) ||
        typeof e.suspected !== 'boolean' ||
        (e.evidenceHash !== null && !digest(e.evidenceHash)),
    )
  )
    throw new Error('Invalid incident observations');
  // Both suspected and confirmed incidents stop expansion. Evidence can follow;
  // missing receipts cannot be used to delay containment or authorize a replay.
  const stopLatched =
    input.previous?.stopLatched === true || input.events.length > 0;
  const blockers: string[] = [];
  const { candidate, rollback, confinement } = input;
  if (
    !digest(candidate.sourceFingerprint) ||
    !named(candidate.version) ||
    !digest(candidate.clientSha256) ||
    typeof candidate.serverChanged !== 'boolean' ||
    (candidate.serverChanged
      ? !digest(candidate.serverSha256)
      : candidate.serverSha256 !== null)
  )
    blockers.push('exact_candidate_build_required');
  if (!input.evaluation) blockers.push('real_comparison_and_holdout_required');
  else {
    try {
      const evaluation = reviewIteration(input.evaluation);
      if (
        candidate.sourceFingerprint !==
        input.evaluation.regression.plan.afterSource
      )
        blockers.push('candidate_differs_from_evaluated_source');
      if (evaluation.admission !== 'manual_pilot_review')
        blockers.push(
          'real_comparison_and_holdout_required',
          ...evaluation.blockers.map((b) => `evaluation:${b}`),
        );
    } catch {
      blockers.push('invalid_evaluation_records');
    }
  }
  if (
    input.humanReview.approved !== true ||
    !named(input.humanReview.reviewer) ||
    !digest(input.humanReview.evidenceHash)
  )
    blockers.push('independent_human_review_required');
  if (
    !input.targets.length ||
    input.targets.some(
      (t) =>
        !exactId(t.accountId) ||
        !exactId(t.tenantId) ||
        !digest(t.testOnlyEvidenceHash),
    ) ||
    new Set(input.targets.map((t) => `${t.accountId}\0${t.tenantId}`)).size !==
      input.targets.length
  )
    blockers.push('exact_test_account_tenant_pairs_required');
  if (
    confinement.dedicatedClientProfile !== true ||
    confinement.testApiOnly !== true ||
    confinement.manualInstallOnly !== true ||
    !digest(confinement.dispatchFenceRehearsalHash)
  )
    blockers.push('test_isolation_and_stop_fence_required');
  const rehearsal = rollback.rehearsal;
  const clientRollback =
    digest(rollback.clientSha256) &&
    rollback.clientSha256 !== candidate.clientSha256 &&
    digest(rollback.clientBackupSha256) &&
    named(rollback.owner) &&
    digest(rollback.runbookHash) &&
    rehearsal?.passed === true &&
    rehearsal.restoredDataVerified === true &&
    digest(rehearsal.evidenceHash) &&
    rehearsal.candidateClientSha256 === candidate.clientSha256 &&
    rehearsal.rollbackClientSha256 === rollback.clientSha256 &&
    rehearsal.clientBackupSha256 === rollback.clientBackupSha256;
  const serverRollback = candidate.serverChanged
    ? digest(rollback.serverSha256) &&
      rollback.serverSha256 !== candidate.serverSha256 &&
      digest(rollback.serverBackupSha256) &&
      rehearsal?.candidateServerSha256 === candidate.serverSha256 &&
      rehearsal?.rollbackServerSha256 === rollback.serverSha256 &&
      rehearsal?.serverBackupSha256 === rollback.serverBackupSha256
    : rollback.serverSha256 === null &&
      rollback.serverBackupSha256 === null &&
      (!rehearsal ||
        (rehearsal.candidateServerSha256 === null &&
          rehearsal.rollbackServerSha256 === null &&
          rehearsal.serverBackupSha256 === null));
  if (!clientRollback || !serverRollback)
    blockers.push('rollback_not_rehearsed_for_exact_artifacts');
  const monitoringComplete =
    input.monitoring.complete === true && digest(input.monitoring.evidenceHash);
  if (!monitoringComplete) blockers.push('monitoring_incomplete');
  if (stopLatched) blockers.push('critical_incident_stop_latched');
  return {
    pilotId: input.pilotId,
    candidate,
    state: stopLatched
      ? ('stopped' as const)
      : blockers.length
        ? ('blocked' as const)
        : ('ready_for_test_pilot_approval' as const),
    stopLatched,
    blockers: [...new Set(blockers)],
    allowedTargetPairs: input.targets,
    incidentIds: input.events.map((e) => e.id),
    actions: [
      ...(stopLatched || !monitoringComplete
        ? [
            'freeze_new_dispatch_and_expansion',
            'reconcile_in_flight_effects_without_replay',
            'preserve_native_evidence',
          ]
        : []),
      ...(stopLatched
        ? [
            'operator_assess_and_run_rehearsed_rollback',
            'new_review_required_no_automatic_resume',
          ]
        : []),
      'separate_human_decision_required_before_test_use',
      'separate_release_decision_after_pilot_data_and_human_review',
    ],
    automaticExpansionAllowed: false as const,
    automaticRollbackAllowed: false as const,
    productionReleaseAllowed: false as const,
    executionPerformed: false as const,
    limitations: [
      'Offline declarations and evidence hashes are not a deployed access-control or kill switch. Native witnesses and a trusted persistent controller must enforce them.',
      'A reversible client is not a reversal of messages, deployments or data changes; reconcile external receipts before any recovery action.',
      'No input here can grant production publication, automatic expansion, or permission to erase an existing stop latch.',
    ],
  };
}
