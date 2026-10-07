# 1.9.20 delivery mechanism RED/GREEN evidence

Journeys derived from the observed failed delivery, not from an executable plan:

- An operator gets one exact direct rollback receipt despite noisy verification;
  unhealthy verification never records success.
- An interrupted upload resumes only after proving the local prefix identity;
  unaccepted bytes cannot advance an update pointer.
- Recovery stops within fixed attempt/job bounds; auth, role and identity errors
  do not become retry-based permission bypasses.

## Checkpoints (active fix branch)

| Stage          | Commit   | Actual evidence                                                                                                                   |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| rollback RED   | 353cbebe | 6 tests executed; 4 new direct-path tests failed due to stdout contamination; 2 existing recovery tests passed                    |
| rollback GREEN | bac1ee02 | same rollback target plus finalization: 12 passed                                                                                 |
| upload RED     | db6c04d3 | client 6 failed / 1 passed; actual Linux root integration stopped at unsupported `upload-status`                                  |
| upload GREEN   | 891d2148 | 126 focused tests passed / 2 existing platform skips; isolated Linux root suite passed timeout/resume and unsafe-prefix rejection |

Safety follow-up checkpoints:

- RED `dcda6d70`: actual Linux gateway accepted a second SHA identity for a retained role prefix; the new safety test rejected that behavior.
- GREEN `6c4ea52e`: same Linux root suite passed; rejects competing identities, hardlinks and trailing bytes. Joint client/root resume and noisy direct rollback replay also passed.

Commands actually executed with installed Node 22.23.1 / Vitest 4.1.11:

```text
node node_modules/vitest/vitest.mjs run scripts/tests/enterprise-rollback-receipt.test.js --config scripts/tests/vitest.config.ts
node node_modules/vitest/vitest.mjs run scripts/tests/enterprise-upload-client.test.js --config scripts/tests/vitest.config.ts
node node_modules/vitest/vitest.mjs run scripts/tests/enterprise-upload-client.test.js scripts/tests/enterprise-rollback-receipt.test.js scripts/tests/enterprise-oneclick-installer.test.js scripts/tests/enterprise-deploy-workflow.test.js scripts/tests/release-deploy-workflow.contract.js --config scripts/tests/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts --reporter=dot
```

Full scripts result: **76 files, 920 passed / 32 existing skipped**, no failure.
Windows-only runner skips remain visible; this is not whole-repository or release CI certification.
`doctor` passed through the actual npm entrypoint (npm 11.13.0, Node 22.23.1);
calling doctor directly initially could not launch npm.cmd on this Windows host.
Modified JS test lint passed; code-map check and diff whitespace check passed.

Linux suite command used the same digest and restrictions as CI:

```text
docker run --rm --network none --pids-limit 256 --memory 512m --cpus 2 --security-opt no-new-privileges --user 0:0 -e OTTO_CI_INTEGRATION_CONTAINER=1 -v <checkout>:/workspace:ro python@sha256:0f5b26b9518d002b6173fd61daad821fa340635ebfec5bba471013f9ca114579 bash /workspace/scripts/tests/enterprise-ci-linux-integration.sh
```

It executes the actual root gateway, filesystem ownership, quotas, signatures,
locks and receipt writes with synthetic fixtures, inside a disposable container.
Privileged fixed paths on the host and production were not touched.
The timeout test changes **only** the container's gateway alarm to 1 second,
then restores it. Production source still uses 1800 seconds; no env bypass exists.
The final helper/rollback/finalization target passed **20 tests** after test-only
formatting/refactoring. Modified-test lint remained clean.
The final Linux suite additionally executes the shared client and receiver
together with local SSH transport, checks role isolation and one unfinished
identity per destination, and checks the full direct rollback replay command.

## Guarantees and limitations

| Guarantee                                                                                      | Target                                       | Scope                                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| First/repeated direct rollback separates verifier diagnostics                                  | enterprise-rollback-receipt.test.js          | actual command tails with noisy/failing adapters                |
| Lost receipt, matching prefix and three-attempt exhaustion                                     | enterprise-upload-client.test.js             | actual shared helper, synthetic SSH, no network                 |
| Wrong prefix, changed local source, denied status, unknown role and noisy success fail closed  | enterprise-upload-client.test.js             | no transfer on invalid state; exact success comparison retained |
| Timeout preserves root-only prefix; stale offset, symlink, bad owner/mode and final SHA reject | enterprise-ci-linux-integration.sh           | real Linux filesystem/gateway, synthetic bytes                  |
| Legacy uploads, signing trust, atomic mirror selection and compensation stay guarded           | full Linux fixture + existing contract tests | existing boundaries, not actual public transport                |

The initial helper run uncovered Bash dynamic-scope shadowing of a synthetic
fixture variable; that fixture was renamed. Existing static contracts were
updated to the new `partial_fd` name, quota subtraction, and actual shared
helper invocation, not relaxed to skip fsync, quotas, hashing or receipts.

Bash and inline Python are not instrumented by the repository's V8 coverage
provider; no numeric 80% production-shell coverage is claimed. Runtime cases
cover the new transitions, but real SSH throughput, production filesystem
durability under power loss and existing-account business behavior remain
separate acceptance tasks. No paid model calls or published-asset changes.

The [original-artifact recovery plan](../../docs/releases/1.9.20-delivery-recovery-plan.md)
is explicitly pending further implementation, CI and separately scoped approval.
Normal release jobs must not be rerun with the burned public version.
