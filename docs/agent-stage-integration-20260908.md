# Agent stages 0–7 integration candidate

This is a source integration, not a product release, production deployment or
claim that all stages are complete.

## Scope and preservation

- Base: `internal` at `93dcf8ea2dd0e9582589351a6e126ecd24b33b86`.
- Integrate the Agent execution/constraints/evidence/continuity/repair/output
  work, deterministic evaluation infrastructure and stages 0, 4 and 5 refinements.
- Full-file changes were taken from the verified local stage-4 snapshot
  `bc7d0a95c40f62a9861bdb2a7fef8401a110238879538531b67a8bdb33a5dd81`.
  Shared protocol/server/UI hunks were separated in a clean worktree.
- Keep the paired enterprise-switch race guard and its regression in the shared
  conversation store; stale observations must not be uploaded after switching.
- Unrelated unfinished recruitment, enterprise-memory version UI and Skill
  release work remains in the original working directory. It is not part of
  this candidate. No original uncommitted files were reset or deleted.
- Do not publish local configuration, keys, recovery packages, raw evaluation
  runs, dependency archives, caches, generated JS, installers or release tags.

## Integration checks

The isolated source candidate passed 902 Agent regression tests with one
existing skipped kernel-file inventory check, plus 239 desktop regressions.
Core/server build and type checking, desktop main/preload/renderer type checking,
production ESLint, code-map freshness and source size checks passed locally.
These counts overlap other recorded stage runs and must not be added to them.

The local dependency layout uses existing installed package links. Evals type
checking needs `--preserveSymlinks` for this layout; the ordinary invocation
reports conflicting Node declaration versions. Clean-install CI remains the
authority for the normal build environment. No paid model was called.

Two pre-existing CI blockers were corrected without disabling their checks:

1. The source integration ledger now matches the already-existing schema 26
   and policy/carpool capability constants. It does not change migrations,
   increase product versions or attest to a deployed upgrade.
2. The policy consistency regression imports its comparison helper through the
   server's explicit public export instead of crossing a private source path.
   The assertions are retained.

The expanded evaluation-infrastructure run has 174 passing and four failing
tests (23 files). It is not a passing merge gate. Failures are preserved in the
local `agent-publish-validation-20260908/evals.json` report:

- `agent-runtime-adversarial.scenario.test.ts`: legacy recovery/completion
  expectations do not agree with the tightened delivery gate.
- `safetyLiveness.scenario.test.ts`: read-only and constrained-document positive
  cases are classified as external/destructive work and cannot complete.
- `realTasks/continuity.scenario.test.ts`: the unknown-outcome restart probe did
  not reach its required crash point; no exactly-once success is claimed.

The original checkout is shallow. Local Git-ancestry integration tests cannot
prove historical containment until full history is available. No ancestry
assertion was disabled. The policy public-boundary regression passed all four
assertions; source-ledger and package-boundary checks passed locally.

Keep this PR unmerged until these failures are investigated and required CI
passes. Published source is not an assurance of end-to-end readiness.

## Remaining limitations

- Stages 0 and 7 still have no completed, fixed-real-model 24-run A/B comparison.
  Scripted providers verify infrastructure, not model quality or task success rates.
- Stage 4 still needs a host-verifiable isolated re-verification executor;
  arbitrary shell errors with durable recovery remain reconciliation-required.
- Stage 5 evidence checks are not an independent general semantic truth judge.
- No GUI/production tenant pilot, installer release, server deployment or
  restart of the user's Otto is authorized by this source integration.

## Rollback

Revert this PR's merge commit on `internal` through a new reviewed change.
Do not reset the original dirty worktree, alter old release repositories or
roll back production data as part of a source rollback.
