# 1.9.15: bounded carpool background maintenance

Release review found that the service's account slice did not bound its database
maintenance: startup scanned all records and re-encrypted unchanged workflows.
This is a release-load fix, not a production deployment or capacity certification.

- Automatic cleanup uses committed, process-local keyset pages: four intents,
  32 publication receipts and four workflows. A fixed high-water mark completes
  each finite cycle; rollback does not advance it. Restart safely rescans rather
  than claiming durable/shared progress.
- The first resident batch waits 30 seconds; the existing lease, cancellation and
  shutdown paths remain. Each batch refreshes at most four accounts, one candidate
  page and one group candidate per active account.
- Limits are checked inside actual background workflow transactions, not by a
  racy preliminary check: 1 MiB ciphertext, 256 referenced principals, 200 park
  intents and 256 relevant approved devices. Over-budget context is deferred in
  full, never truncated before reconciliation. Foreground and explicit personal
  data deletion retain their full-context semantics.
- Unchanged workflow ciphertext/version is preserved. Referenced account checks
  include active membership, park and organization even after an intent is gone.
- PostgreSQL intent/publication locks share a total order. Background statements
  have a five-second timeout and lock waits one second; this is NOT a five-second
  deadline for the entire transaction, nor proof of a bounded physical table scan.
- `getState.backgroundRefresh` reports deferred reason/time. Process caches are
  limited to 1,024 entries with a 24-hour TTL. No new GUI banner or schema is added.

## Verification and remaining release evidence

Original regressions failed for unchanged ciphertext rewrites, oversized cleanup
and immediate startup. Final local Node 22.23.1 Windows run, at `689d80d2` plus the
ten reviewed server changes: 17 files, 115 passed, zero failed, 31 PostgreSQL cases
skipped because no local PostgreSQL binaries were available. Typecheck, scoped
lint, code-map and diff checks passed. Raw result SHA-256:
`e9d827268d235a95ca43007e4e3ccb189b6715424cb8080f001c4f4e64b6e6fe`.

Independent source review caught and corrected lock-order and composite-FK
fixture defects. The next exact-source CI must run the real PostgreSQL 17 cases,
including concurrent foreground/background locking; skipped local cases are not
acceptance evidence. Full CI, actual installers, upgrade acceptance, signed server
canary, deployment and public update verification remain separate release gates.
