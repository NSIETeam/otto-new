# 1.9.21 native vendor installer-filter regression

Journeys were derived from the real artifact-only packaging failures, not a
provided plan. Customers must receive runtime files and complete license texts,
without accidentally shipping Rust compiler inputs or weakening package gates.

## Preserved failure and TDD checkpoints

Artifact-only run `37566081251`, exact source
`7fd661417a84ee9f46be1c2a4e75d414fb214dc2`, failed Windows and macOS ARM builds.
The unchanged ASAR gate rejected the vendored `Cargo.toml` and four Rust source
files. This is a packaging defect, not an accepted exception or successful
installer. Public job logs and hashes are retained outside the repository.

- RED `05bdac88`: actual normalized macOS/Windows dependency matchers admit
  build-only vendor files; real filtered ASARs reproduce the same five gate
  violations. Seven tests executed: four failed, three passed. License retention
  and gate rejection tests already passed.
- GREEN `81d1457a`: add only two scoped desktop exclusions, native vendor
  `Cargo.*` and `*.rs`. All 71 tests passed across four packaging test targets.
- Formatting-only follow-up reran those same targets: 71 passed, zero failures.
  Node 22.23.1, Vitest 4.1.11; no dependency-lock, rule, budget or threshold edit.

Actual focused command, run from the workspace root:

```text
node node_modules/vitest/vitest.mjs run --root packages/desktop scripts/packaging-native-vendor.test.mjs scripts/verify-packaged-content.test.mjs scripts/packaging-tokenizer.test.mjs scripts/packaging-contract.test.mjs
```

| Guarantee | Test | Result |
| --- | --- | --- |
| Both normalized platform matchers omit Rust and Cargo compiler inputs, including nested dependencies | vendor matcher regressions | PASS |
| Full upstream MPL license and NOTICE bytes survive real ASAR filtering | two real ASAR regressions | PASS |
| Native JS wrapper, package metadata and unrelated vendor runtime files survive | license/runtime matcher regressions | PASS |
| Existing content gate still rejects the five leaked compiler inputs | gate regression | PASS |
| Existing size budgets, locale trimming, native signing order, tokenizer and content contracts remain enforced | three existing targets | PASS |

## Verification boundaries

This change affects packaging configuration, not runtime business logic. The
seven new integration/contract tests execute the real electron-builder
matchers and ASAR IO, rather than asserting string-pattern presence only.
Code-map check and doctor passed; unchanged workspace source budget remains
55 MB. No coverage threshold or old failure evidence was changed. A percentage
coverage metric does not measure JSON file-filter declarations; do not present
these tests as 80% whole-desktop coverage.

The full tracked corresponding-source distribution still contains the vendored
crate, modified manifests and license files. It remains required for release;
this exclusion is not removal of upstream source from that distribution.
Fresh cloud CI, all three actual installers, same-ASAR multi-format checks,
formal install/upgrade, encrypted history/device continuity and signed update
integrity must still pass. No public release or production mutation is proved
by these local tests.
