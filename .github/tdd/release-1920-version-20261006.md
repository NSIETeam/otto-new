# 1.9.20 metadata-only release preparation

The product owner explicitly authorized one validated 1.9.20 publication after
the failed, never-published 1.9.19 run. Do not rerun the failed workflow or reuse
its one-time approval/credential receipt. Public production remains 1.9.18 until
all protected publication gates pass.

Packaging fixes and their valid RED/GREEN checkpoints are preserved in
[packaging-size-20261006.md](packaging-size-20261006.md) and
[desktop-packaging-validation-20261006.md](desktop-packaging-validation-20261006.md).
PR #88 passed all CI, media, SQLCipher, systemd and real Windows seed checks
before merging. PR native attestations are intentionally not issued; release
consumers must rebuild/attest the exact internal source.

This change runs the repository's existing `node scripts/version.js patch`
mechanical metadata updater. It adds no business logic, changes no dependency
pin, and relaxes no existing gate. The existing version-consistency and
artifact-only workflow tests were run before changing metadata (2 files / 12
tests passed), then the same two suites plus release-mode and October dependency
contracts ran after updating (4 files / 46 tests passed). There is no new RED
business-rule claim for a metadata-only bump. `code-map:check` and diff whitespace
checks passed.

The first candidate CI (`37429848758`, build job `112157896731`) correctly
rejected the unchanged integration ledger: its client/server version was still
1.9.19. A local run reproduced the same three failures in nine existing ledger
tests. The version updater omitted that ledger, so a new real-child-process
regression was added before fixing it: six tests executed, one failed because
the ledger remained 1.9.19 while the fixture package advanced to 1.9.21. The
RED commit is `f0839e1a`. The updater now changes only the two version fields,
preserving the ledger's schema, capabilities, trust and source history. The
candidate ledger is aligned to 1.9.20 without another version increment.
After the fix the two version suites plus packaging validation, release-mode
and October dependency contracts passed: five files / 56 tests. This is a
release metadata defect, not a newly discovered end-user runtime failure.
The complete local script suite then passed 75 files / 900 tests, with 32
existing conditional platform skips; explicit lint on the two changed scripts,
Node 22 doctor, code-map check and Git whitespace check passed. Two mistyped
diagnostic invocations (a nonexistent doctor.mjs and a workspace-local npm CLI)
failed before the actual package.json doctor.cjs entry was run successfully;
neither failure is counted as a passing check.

The next CI (`37430864555`, job `112161143638`) executed all 2247 desktop
assertions successfully, but the read-only coverage ratchet rejected the exact
lockfile measurement identity. Preserved artifact `11397492074` is bound to
tested PR merge `df74ab2511f6af4e31c4d1a014f53e2499b16b5d` / candidate
`87feadfd26c135b8c98ade7f703dbac185af5751`. A separate real Windows run
`f0d6369b-8fd3-4de2-b8b3-39b00088651a` also completed 2247 assertions in 271
files with native exit code zero; neither rejected receipt is rewritten.
Both platform reports were independently compared with their own old baseline:
the entire lockfile differs only in four workspace version fields, and only
two preview display literals change. All preview uncovered counts are identical
and all 282 unrelated file entries and required tests are preserved. No source
is excluded, no site/count tolerance is introduced, no instrumentation hint or
threshold is changed, and the native runner/verifier remain untouched.

RED `315ce41c` records two failing assertions for the absent explicit version
review; the seven prior evidence tests remained passing. The platform-specific
`release-1920-*-review.json` records now bind exact native reports, raw hashes,
parents, unchanged entries/tests and the historical 1.9.19 -> 1.9.20 chain.
The reviewer is explicitly the authorized root agent, not independent human
approval. Focused ratchet/runner/version/packaging checks passed 6 files / 123
tests; the full local script suite passed 75 files / 902 tests with 32 existing
conditional skips. A new Windows native run and fresh full CI are still required
after the reviewed metadata is encoded.

Cheap script tests now also compare baseline lock identity with the actual
current lockfile so this type of drift is caught before long builds, and a
real-child-process version test proves the version updater does not silently
rewrite either reviewed platform baseline. The updater remains a metadata
updater, not an automatic approval mechanism.

Fresh Windows execution `34e60f58-e0c2-43b8-bb63-1ec996737b6b` subsequently
completed with native exit code zero and `gate=passed`; this is a new execution,
not relabeling the old rejected observation. The old and new Windows receipts
remain in their distinct runner-owned directories. Current-source macOS CI and
actual three-platform installer validation are not yet complete.

The added no-auto-baseline-rewrite assertion initially used deep object equality
on two 1.3 MiB buffers; one full-suite run took 6.1 seconds in that test and
correctly hit the unchanged five-second timeout (901 passed / 1 failed). It now
uses native `Buffer.equals` for the same exact byte comparison, not a larger
timeout, omitted assertion or relaxed identity check.
After this implementation correction the two focused suites passed 15 tests
in under a second, and the final complete script suite passed 75 files / 902
tests (32 existing conditional skips) under the original test timeout. Explicit
changed-script lint, Node 22 doctor, code-map and whitespace checks passed.

Commands executed from repository root with Node 22.23.1 / Vitest 4.1.11:

```text
node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts scripts/tests/release-version-consistency.test.js scripts/tests/desktop-packaging-validation.test.js
node scripts/version.js patch
node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts scripts/tests/release-version-consistency.test.js scripts/tests/release-mode.test.js scripts/tests/desktop-packaging-validation.test.js scripts/tests/release-october-security.test.js
node scripts/generate-code-map.mjs --check
git diff --check
```

Remaining proof is explicit: full CI for this exact metadata commit; actual
Windows/Intel Mac/ARM Mac installers below the unchanged byte ceilings; real
installation/upgrade and crypto continuity; production signatures, isolated
canary, rollback and public old-client update paths. Diagnostic packaging is not
a release or an installation acceptance. The prior six synthetic model calls
were consumed and passed adapter-to-tool smoke, not arbitrary agent quality;
this preparation makes no additional paid request.
