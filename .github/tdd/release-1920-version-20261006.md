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
