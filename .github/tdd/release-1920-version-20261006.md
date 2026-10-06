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
