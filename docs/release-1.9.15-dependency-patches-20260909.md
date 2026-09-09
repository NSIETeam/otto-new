# 1.9.15 dependency security repair — 2026-09-09

Status at this review: **focused dependency regressions 27/27 passed; live audit returned to the unchanged, narrowly reviewed exception. Core full regression passes. Desktop assertions pass, but coverage validation is still under investigation; PostgreSQL tests require the real database CI environment. This document is not publication approval and does not claim that 1.9.15 has been published or deployed.**

## Why the release stopped

Release run `34326917530`, source `019be378243c83fe50167413a03a4a256dcc26ee`, failed at **Enforce release dependency audit** before product build or publication. The strict severity-total comparison rejected the changed report. Create-intent, draft, enterprise deployment, canonical publication, update mirror, legacy publication and finalization jobs were skipped.

The original CI JSON was not preserved; the following before report is a fresh reproduction, not a recovered CI report. The unchanged public lock was audited against the official npm registry using Node **22.23.1** and npm **10.9.8** on 2026-09-09 at **08:28:25–08:28:32 UTC**. Its counts were `moderate=4, high=3, total=7`, versus the reviewed `moderate=0, high=2, total=2` baseline. Five newly registered advisories propagated through five additional package records; package totals are not distinct-advisory totals.

The GitHub advisory database published/reviewed these five entries on September 8; upstream disclosures were earlier. New advisory data can reject an unchanged lock. The response here was to install upstream fixes, not enlarge the exception or suppress the audit.

## Exact fixes and reachability

| Advisory | Locked before → after | Assessment and verification boundary |
| --- | --- | --- |
| [js-yaml empty-merge amplification, GHSA-2883-xcg3-v3hh](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh) | Root `4.3.1 → 4.3.2`; `gray-matter/node_modules/js-yaml` `3.15.1 → 3.15.2` | The production `gray-matter` parser calls `safeLoad`; Skill parsing, draft validation and loading call `matter(...)`. This is a real parser entry point. A three-empty-map input exceeding a budget of one reproduces the missing accounting without a large CPU payload. Both patched lines pass normal and over-budget checks. |
| [Hono SSG path traversal, GHSA-gqvv-2mrq-wpjv](https://github.com/honojs/hono/security/advisories/GHSA-gqvv-2mrq-wpjv) | `4.13.1 → 4.13.5` | Hono is a production transitive dependency of MCP SDK 1.30.0. No first-party `toSSG` path was found. This advisory is covered by the upstream-fixed version pin and fresh audit, not by a claimed Otto end-to-end exploit test. |
| [Hono dot-notation allocation, GHSA-g6gw-c38x-mqfc](https://github.com/honojs/hono/security/advisories/GHSA-g6gw-c38x-mqfc) | `4.13.1 → 4.13.5` | Upstream requires explicitly enabled dot-notation parsing; no first-party use of that sink was found. The version is fixed regardless. Static absence of a call is not proof of universal non-reachability. |
| [Hono fragment/query confusion, GHSA-crvj-82cr-hjcx](https://github.com/honojs/hono/security/advisories/GHSA-crvj-82cr-hjcx) | `4.13.1 → 4.13.5` | Actual installed query helpers are tested with legitimate parameters, a question mark after a fragment, fragment termination and encoded hashes. These are in-memory parser tests; they do not establish that Otto's live ingress accepted the malformed target. |
| [Vitest redirect-file disclosure, GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) | Vitest, mocker and coverage `3.2.7 → 4.1.11` together | Upstream states that the 3.x line has no planned fix. Checked-in Otto configurations use CLI tests; no public standalone mocker plugin or enabled browser mode was found. The real installed interceptor and Vite allowlist are nevertheless exercised for allowed, traversal and denied redirects, and disabling unauthenticated registration. Only the transport is replaced with an in-memory event adapter; no server is exposed and no sensitive file is read. |

The Vitest choice follows the [4.1.11 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11) and [upstream boundary fix](https://github.com/vitest-dev/vitest/commit/fe5a11d3ceac5ec10d6d7d21a46d4caca132c48f). The three packages are aligned, rather than leaving vulnerable mocker/coverage copies on 3.x. This is a necessary major test-tool migration, not merely a patch-number change.

## Independent lock review

Comparison was against the complete source `019be378` lock, not an assumed earlier dependency environment. The repaired lock has **93 changed records, 3 added records and 19 removed records**, including workspace metadata and deduplication. This does **not** mean 93 package version upgrades.

- Vite remains **7.3.6**; Vite 8 is not introduced. No `--force` or `--legacy-peer-deps` resolution was used.
- Test/build-chain changes include Babel parser/types `7.29.7 → 7.29.8`, Rollup and platform bindings `4.62.2 → 4.63.1`, and Vite's esbuild/platform bindings `0.28.1 → 0.28.2`. Vitest 4 also changes coverage, assertion and runner dependencies, including `ast-v8-to-istanbul 0.3.12 → 1.0.6`, Chai 6, and removal of `vite-node`.
- The new `@napi-rs/lzma-linux-x64-gnu@1.5.1` record is Rollup 4.63.1's exact optional dependency, not a new Otto runtime dependency. `convert-source-map@2.0.0` is required by `@vitest/utils`; `obug@2.2.1` by Vitest/coverage.
- One change is **not dev-only**: `es-module-lexer@2.3.2` is hoisted to the root. Production `import-in-the-middle@3.3.3` already required `^2.2.0` and previously resolved its nested `2.3.1`; its effective runtime change is **2.3.1 → 2.3.2**, not the apparent root `1.7.0 → 2.3.2` major upgrade. Vitest `^2.0.0` and webpack `^2.1.0` share the compatible hoisted version. This remains within full regression scope.
- No unexpected package registry was found. The original exception and expected-report JSON are unchanged from `019be378`.

The [Vitest 4 migration guide](https://v4.vitest.dev/guide/migration#v8-code-coverage-major-changes) documents changed V8 coverage remapping, removed options and changed defaults. **Coverage percentage changes across this migration cannot be presented as a change in business quality.** Preserve the intended file population and thresholds, inspect missing files, and explain measurement differences. Mock constructor and restoration semantics also require full-suite validation; focused security tests cannot establish migration compatibility.

## Regression evidence

`scripts/tests/release-dependency-patches.test.js` extends the existing suite:

- **All original 8 fast-uri/qs tests and their assertions are retained unchanged.** The existing `OTTO_DEPENDENCY_PATCH_ROOT` isolated-runtime support is retained and used by the new imports.
- **19 added tests** cover six exact lock/installed version pins, four bounded YAML tests, real gray-matter frontmatter, three Hono query cases, and five Vitest redirect/guard cases.
- Before installation, the 19 new checks produced **15 failures / 4 passes** under real Vitest 3.2.7. That report remains separate. A combined run during installation also remains recorded; it is not counted as a completed post-install result.
- After installation, the complete suite produced **27 passes / 0 failures** under Node 22.23.1 / Vitest 4.1.11. Single-file lint and `git diff --check` passed.
- No large denial-of-service input, public test server, arbitrary payload execution or production operation was used by these tests.

Reproduction from the repository root (using the fixed runtime described above):

```sh
node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts scripts/tests/release-dependency-patches.test.js
```

The release owner separately obtained a new **live** official-registry audit after installation. Independent review parsed that raw report and reran the complete `verifyReleaseDependencyAudit` checks against it, including current manifests, lock, project source reachability and installed PptxGenJS runtime hashes. The independent replay does not substitute for the next release job's required live audit.

### Full migration checks recorded by the release owner

- Core: **225 test files / 3008 passed / 0 failed / 25 conditional skips** using the real Node 22.23.1 runtime. Constructor mocks now support `new`; mock restoration/reset fixes preserve the existing assertions. No product implementation or skip predicate changed. The genuine Chrome PNG test fails in the restricted process sandbox but passes in the approved isolated local-browser execution. The full run discovers installed Marp, so the existing missing-Marp negative is conditionally skipped there; that same negative passed in the preceding restricted runs. It is not counted as passed in the full run.
- Core V4 coverage: statements **53.01%**, branches **45.88%**, functions **56.29%**, lines **54.32%**. The include glob retains all source code extensions, excluding Markdown/HTML templates from attempted JavaScript instrumentation. These values are not a cross-version product-quality comparison.
- Server local full run: **3014 passed / 26 failed / 24 skipped**. All 26 failures require PostgreSQL, which is absent on this local Windows environment. The release CI provisions PostgreSQL 17 and must independently pass them; absence is not acceptance.
- Desktop second full run: all **264 test files** pass, including the ten original product module-load failures. A test-runtime-only resolver externalizes exactly `node:sqlite`, which Node 22 recognizes as a builtin but omits from `builtinModules`. The final focused regression uses only the real native SQLite engine to verify identity, parameter binding and rollback while retaining jsdom (2/2 pass); it does not add a cross-package source import or claim an adapter-level test. Coverage still fails its unchanged functions/branches thresholds at this checkpoint; it remains a release blocker.
- Scripts: **49 files, 524 passed, 5 original conditional skips**. Deterministic evals: **17 files, 131 passed**; not real-model comparative scores. Workflow: **21 passed, 2 original Windows skips**. RPA: **46 passed, 1 original skip**. Repository CI lint and pre-final-test-edit workspace typechecking pass; final CI/build remains required.
- A subsequent discovery regression retains Vitest 3's exact generic exclusion rules instead of a narrow `src` include. All existing Core/Server/RPA/Workflow test sets remain **225/386/8/4**. Seven new checks pass, including actual root/workspace server invocation and filename-only collection of the existing park integration entry point; listing is not a PostgreSQL execution claim. The final Core coverage glob also retains `.mjs/.cjs/.mts/.cts`, so its existing test-agent `.mjs` fixture is not silently removed from the include population. The full Core values above precede that final extension correction and will be superseded by clean CI.

| Checkpoint | Result |
| --- | --- |
| Before live audit | `moderate=4, high=3, total=7`; five new advisories present |
| After live audit | `moderate=0, high=2, total=2`; new five advisories absent |
| Existing exception | Only `pptxgenjs@4.0.1 → image-size@1.2.1`, the same two GHSAs and reachability contract |
| Expiration | Still **2026-09-15T00:00:00Z**; no extension or additional allowed finding |
| Audit command exit | `1`, because the two explicitly reviewed findings remain; the strict release verifier passes |
| Full migration/regression/packaging | **Pending at this review**, to be recorded by the release owner |

There is no claim of a zero-vulnerability audit. Any changed advisory identity, new finding, unexpected reachability or expiry must still fail the release gate.

## Immutable evidence index

Raw reports remain in local diagnostics, not inside an installer or the source commit. Paths below are relative to the local `D:/otto/diagnostics` evidence root. They contain audit/test data, not credential exports.

| Evidence | File / SHA-256 |
| --- | --- |
| Original public lock | `019be378` Git blob `db7e0323a259912c7fa97cfbcc45461ee3fd942e`; SHA-256 `e0648bc1a6e05624228c63363b66afa41d01b7e0e488eaa35a9597fb8f83ccc7` |
| Before raw audit | `dependency-audit-019be378-20260909/actual-npm-audit.json`; `52dec9111c1fca5be12e8d681eb8d9e81629b3655d3a6500217fbf9b87d0c484` |
| Repaired lock | `9bf3ec93187c192686e30fdea62e62a769734405085d6e49d675c5efc2723600` (unchanged before/after the new audit) |
| After raw audit | `dependency-patches-20260909/audit-1788943289745/stdout.txt`; `b4e2c1d613706bde82f28e513aac85a184e46b3c457a7e0083476be81999fd02`; adjacent `receipt.json` records runtime and lock hashes |
| Focused RED / GREEN | `dependency-audit-019be378-20260909/patches-red.json` and `patches-green-attempt1.json` |
| Detailed lock comparison | `dependency-audit-019be378-20260909/lock-diff-review.json` |

The repaired dependency changes were still uncommitted when this evidence was produced; the release owner must bind the eventual candidate commit to this lock fingerprint and rerun required CI. **No production server was accessed or changed by this independent dependency review.**
