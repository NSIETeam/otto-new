# Shared task recovery and document execution fixes

Scope: internal source fixes for task effort, safe topic switching, conversion
outcomes and document subprocess cancellation. No version bump or release,
production restart, encryption-key change, private-message send or paid model
request is part of this change. All new test inputs are synthetic.

## RED checkpoints

- `2a7c627c`: common Chinese Word/PDF requests and competitive analysis were
  classified with a three-round budget; failed read work blocked a new question.
  Nine server assertions failed. Eight conversion assertions reproduced resolved
  failure text, stale/missing/empty output and ineffective cancellation.
- `8a8ef28a`: runtime still stopped legitimate registered reads after three
  rounds, and there was no atomic read-only abandonment operation. Nine server
  assertions failed; the explicitly configured two-round cap remained enforced.
- `d59730ca`: extracted the existing document command runner without changing
  behavior, then reproduced three cancellation/timeout outcome failures.
- `315c50d8`: two further assertions reproduced a POSIX launcher exiting before
  its helpers were forcibly terminated, and colliding batch output names being
  silently overwritten.

## Implemented behavior

- Recognize common document/conversion and research requests. Retrieval and
  synthesis receive a fixed ten-round effort budget. A registered read tool can
  reveal work missed by the initial lexical classification and promote that
  turn once. Configured session limits, tool exposure, parallelism, confirmation
  and external-write/destructive restrictions remain in force.
- Use the same continuation interpretation at request resolution and recovery.
  A fresh local request may archive settled read-only/control work as abandoned,
  preserving its history. Validation and archival share the serialized recovery
  operation. Pending user steering, writes, running tools and unknown outcomes
  keep the recovery gate. An archival failure retains the active record.
- Conversion errors throw into the existing executor error path. Commands use
  argv and bounded cancellation-aware execution. Each operation stages files in
  a fresh sibling directory, verifies a regular nonempty new output, then
  renames it into place. Failed/cancelled work preserves the old destination.
  Batch destination collisions are rejected before execution; partial batches
  report the actual completion count. Merge/compression use the same contract.
- Generation and conversion share a lightweight process runner. Cancellation or
  timeout wins over a late successful callback. Windows terminates the exact
  spawned process tree; POSIX uses a detached group and bounded escalation even
  if the launcher exits first. Cancellation settles even without an exit callback.

## GREEN verification (Windows, 2026-10-06)

From `packages/core`, with `OTTO_REAL_DOCX_SMOKE=1`:

```text
npx --no-install vitest run src/services/documentCommand.test.ts src/tools/convert-document.recovery.test.ts src/tools/convert-document.test.ts src/tools/generate-document.test.ts --coverage.enabled=true --coverage.include=src/services/documentCommand.ts --coverage.include=src/tools/convert-document.ts --coverage.reporter=text --coverage.reporter=json-summary --coverage.reportsDirectory=coverage/shared-mechanisms --reporter=dot
```

Result: **90 passed, 4 conditional skips**, four test files. The actual local
Python rendered five successive Word documents; the test inspected their OOXML
and body content. Browser rendering and a real synthetic Node child cancellation
also ran. POSIX process-group behavior was tested through injected process calls,
not claimed as a real Linux installation test. Optional real converter cases
remain conditional on local executable availability.

From `packages/server`:

```text
npx --no-install vitest run src/runtime src/turnRecoveryStore.test.ts src/turnContinuation.test.ts src/turnControlPolicy.test.ts src/complexityRouter src/turnPresentation.test.ts --coverage.enabled=true --coverage.include=src/turnRecoveryStore.ts --coverage.include=src/turnContinuation.ts --coverage.include=src/turnControlPolicy.ts --coverage.include=src/complexityRouter.ts --coverage.reporter=text --coverage.reporter=json-summary --coverage.reportsDirectory=coverage/shared-mechanisms --reporter=dot
```

Result: **225 passed**, 17 test files. Includes repeated continuations/restart,
configured hard caps, unknown send/deploy/write recovery, immutable requirements,
receipt-based validation, queued-write races and accepted-but-unapplied steering.

Core/server TypeScript checks, changed-file ESLint, `build:packages`,
`validate:boundaries`, `code-map:check` and `git diff --check` passed.

Scoped coverage: core selected command/conversion files 94.86% lines, 86.53%
statements, 78.75% branches; server selected policy/recovery/router files 97.08%
lines, 94.01% statements, 91.12% branches. Core historical/platform branches
remain below an 80% branch target. No coverage threshold was lowered. Coverage
does not represent the entire runtime or installed application.

## Limits

- Repository doctor still fails the pre-existing 55 MB source-size budget
  (approximately 55.14 MB during verification). All other doctor checks passed.
  The budget was not raised and unrelated assets were not removed.
- This is deterministic/local-engine verification. It does not establish the
  quality of arbitrary model responses, a production private-chat health result,
  a real Linux process-tree result or installation/upgrade acceptance.
- Installed 1.9.18 is unchanged. The earlier tool-initialization and private-chat
  fixes are separate changes; a real multiple-key identity conflict still requires
  checking the original identity and history namespace without deleting keys.
