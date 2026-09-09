# Desktop AST coverage ratchet: measurement migration design

Status: **implemented and wired locally; not release approval.** Desktop
`test:coverage`, CI and release quality gates now use the mandatory runner and
reviewed Windows/macOS baselines in `config/test-baselines/desktop`. The 62% line
and statement gates and source scope remain; the old function/branch percentages
are replaced by the per-file/site gate. The latest Windows run passed all 264
files / 2,074 assertions with native exit 0, but the new gate rejected a newly
uncovered line site in `ParkServicesPlugin.tsx`. Investigation is ongoing. Clean
GitHub CI for this wiring has not run, and no release approval is implied.

## Why the old percentage is not a comparable unit

The actual V3 default and V4 Windows coverage maps both contain the same 281
Desktop source paths and original 263 test files (V4 additionally has two native
SQLite test assertions). The Git-version Desktop src/scripts/config trees from
73fb45e3 to 019be378 are identical. The older run did not archive every dirty
worktree byte; this does not prove a byte-for-byte identical complete workspace.
Different dependencies, isolated home settings and worker counts also prevent a
claim of a controlled product-quality/performance improvement.

The old mapper represents many unloaded files with one synthetic `(empty-report)`
function/branch, sometimes counted as hit even with zero covered lines. A small
fixed-source, fixed-Node, fixed-test experiment produced:

| Mapping           | Never-imported file functions | Never-imported file branches |
| ----------------- | ----------------------------: | ---------------------------: |
| V3.2.7 default    |                           1/1 |                          1/1 |
| V3.2.7 AST option |                           0/3 |                          0/6 |
| V4.1.11 AST       |                           0/3 |                          0/6 |

In the real V4 result, 14 still-unloaded files account for 1,204 functions and
3,043 branches, not the old 14 synthetic entries each. The reported percentage
drop therefore is not evidence of product quality dropping, and a new passing
percentage is not evidence of improved coverage either. Preserve raw reports and
the existing debt. A metric migration requires explicit review, not exclusion of
business files or an arbitrary replacement percentage.

## Implemented gate

The standalone verifier is `scripts/verify-desktop-coverage-ratchet.mjs`.

- The source scope is fixed to the current Desktop `src/**/*.ts,tsx`, excluding
  only the existing tests, declarations and renderer test setup. It inventories
  the checkout itself; a report cannot make a missing source file disappear.
- Every old baseline source file must still have a current observation. Every
  new source file requires explicit baseline review, including apparently fully
  covered files and type-only/comment-only zero-map files. Source deletion also
  requires review. Empty or partial maps are not proof of complete observation.
- It computes metrics from raw Istanbul statement/function/branch maps, not
  `success`, reported percentages or an edited summary JSON.
- Each file's uncovered count may not rise. In addition, uncovered source-span
  signatures cannot silently move to a previously covered arm while keeping the
  same count. AST token ranges and lexical scope distinguish identical fragments
  at separate occurrences. The complete map fingerprint must remain identical
  for the same syntax, even when a harmless comment changed the source-byte hash.
- Source AST structural changes and instrumentation-ignore hint changes require
  explicit baseline review. The verifier does not independently reconstruct all
  Istanbul maps and therefore never automatically certifies newly changed
  business syntax from a possibly incomplete report.
- All current tests must be present in detailed results and every assertion must
  have passed. Empty/missing/skipped/failed suites, stale hashes, nonzero native
  exit codes and incompatible environment metadata fail closed.
- Platform, architecture, Node major, exact Vitest/coverage-provider versions,
  AST mapper, reviewed current config bytes and complete root package-lock bytes are
  pinned. One platform's report cannot fill in another platform's baseline.
- The script only reads. It has no `update`, `accept`, baseline-writing or
  runtime-learning mode. Unsupported options are rejected.

Signatures are syntactic, not a semantic proof of business behavior. Real TS AST
tokens normalize spaces and CRLF/LF; AST hierarchy still distinguishes changes
such as automatic-semicolon-insertion after `return`. Source/test receipt hashes
retain actual input bytes. Refactoring, inserted syntax, source renames, line
wrapping that changes mapped-line observations, or map movement require review.
This is a fixed-version measurement migration, not automatic certification of
every future feature/refactor. Review still needs independent business assertions.

## Exact evidence interface (v1)

All hashes below are lowercase SHA-256 of actual bytes, never guessed. File keys
are canonical `/`-separated Desktop-relative paths; report keys and `item.path`
must resolve under the absolute `--source-root` for the current checkout.

### Current raw inputs

1. `coverage-final.json`: complete raw Istanbul map, including statementMap/s,
   fnMap/f and branchMap/b. Preserve the original bytes and their SHA-256.
2. Vitest JSON: complete `testResults` and assertions. The verifier derives test
   file counts from `testResults`, not `numTotalTestSuites` (which includes describe
   groups). Top-level `success: true` alone never passes.
3. Native run receipt, created by a trusted runner around the real child process:

```text
schemaVersion: 1
exitCode: <actual native child exit code, must be 0 for current verification>
environment:
  platform: <process.platform: win32 / darwin / linux>
  arch: <process.arch: x64 / arm64>
  nodeMajor: <actual process.versions.node major>
  vitest: <installed exact version, currently 4.x supported>
  coverageV8: <same exact installed @vitest/coverage-v8 version>
  mapper: ast
  configSha256: <actual packages/desktop/vitest.config.ts bytes>
  lockSha256: <actual complete root package-lock.json bytes>
reportHashes:
  coverage: <exact coverage-final.json bytes>
  tests: <exact Vitest result JSON bytes>
sourceHashesBefore: { <relative source/test path>: <SHA-256 of UTF-8 bytes>, ... }
sourceHashesAfter:  { <relative source/test path>: <SHA-256 of UTF-8 bytes>, ... }
```

The before/after maps must exactly equal the current source and test inventory.
Source paths are the complete configured coverage scope above. Test paths follow
the unchanged Desktop include patterns: renderer `*.test.ts,tsx`, main/preload
`*.test.ts`, scripts `*.test.mjs`. Config and the full lockfile are separately bound
in `environment`. There is no `accepted: true` or override field.

This v1 manifest binds the coverage source scope, test source files, config and
lock; it is **not** a complete whole-workspace byte snapshot. A trusted runner
should also archive the whole source/dirty-tree manifest and other inputs (e.g.
non-test scripts/assets) as separate provenance and label the scope accurately.

The verifier checks actual current report-byte hashes and re-reads source/test
bytes. It does not cryptographically prove that an arbitrary supplied receipt
was emitted by the real child process. Therefore the CI runner must create and
store the receipt itself in an isolated job, rather than accepting model/user
JSON. It must collect hashes before/after and preserve stdout/stderr and the true
exit status. This patch deliberately does not fabricate a receipt for old runs
whose required fields were not recorded.

### Reviewed baseline input

```text
schemaVersion: 1
scope: desktop-source-v1
status: reviewed-measurement-baseline
environment: <same exact environment shape above, per platform>
review:
  reference: <actual NSIETeam/otto-new pull-request URL reviewing this baseline>
  sourceCommit: <actual full 40-hex Git revision; not a claim the tree was clean>
  coverageSha256: <reviewed original raw coverage bytes>
  testEvidence:
    kind: <vitest-json | github-job-log; label the actual retained evidence>
    sha256: <reviewed original JSON or complete native CI job-log bytes>
  measuredConfigSha256: <config Git bytes associated with the measured candidate>
  sourceManifestSha256: <reviewed canonical source/test manifest bytes>
tests: [<every baseline test path>]
files:
  <relative source path>:
    sourceSha256: <actual reviewed source bytes>
    signatureVersion: typescript-ast-sites-v2
    structureSha256: <TS AST hierarchy and normalized syntax tokens>
    instrumentationSha256: <actual ignore-hint comments, excluding string examples>
    hasIgnoreHints: <boolean observation, not permission to add an ignore hint>
    mapSha256: <summarizeDesktopCoverage map fingerprint>
    metrics:
      lines: { total: <observed>, uncovered: <observed> }
      statements: { total: <observed>, uncovered: <observed> }
      functions: { total: <observed>, uncovered: <observed> }
      branches: { total: <observed>, uncovered: <observed> }
    uncoveredSites:
      lines: [<observed hashed spans, preserving duplicate counts>]
      statements: [...]
      functions: [...]
      branches: [...]
```

`summarizeDesktopCoverage({coverage, sources, root})` returns the exact per-file
structure. It is a pure summarizer, not a baseline writer or approval mechanism.
Review references must be validated by repository review/branch protections;
the script's format validation cannot establish that a human approved a PR.
The exact `status: reviewed-measurement-baseline` is mandatory; drafts and missing
status fail closed. It prevents accidental draft use, not forged human approval:
the status is not a signature and cannot replace Git review/branch protections.
No example above is a usable production baseline.

Historical measurements may come from a run where every real test passed but
the old function/branch percentage gate returned exit 1. Preserve that status;
do not call it an accepted old gate. macOS's retained full GitHub job log is not
Vitest JSON and must use `kind: github-job-log`. Current execution still requires
complete actual Vitest JSON and native exit 0, with no log-substitution shortcut.

For the reviewed V3-to-V4 metric migration only, retain the historical candidate
Git config hash in `review.measuredConfigSha256` and bind `environment.configSha256`
to the separately reviewed new configuration. The only authorized threshold
change is removing function/branch percentages in favor of the mandatory guard;
line/statement 62, scope, mapping algorithm and tests are unchanged. These fields
do not constitute an automatic override or establish review by themselves.
The historical raw Windows config-byte hash was not recorded; the candidate Git
hash must not be mislabelled as a before/after working-tree measurement.

Baselines are gzip JSON files read by exported `readCoverageBaseline(file)`:
regular-file checks, at most 4 MiB compressed and 16 MiB inflated, bounded reads
and before/after file identity checks. Runner and CLI use the same reader.

### Mandatory execution and diagnostic interface

`npm run test:coverage --workspace=packages/desktop` invokes
`scripts/run-desktop-coverage.mjs`. CI and release quality checks use that package
entry point; their evidence uploads preserve the native reports, receipt and
stdout/stderr even when verification fails. The runner writes a fresh per-run
directory, records actual inputs before and after execution, and invokes the
verifier. The direct read-only verification interface remains:

```sh
node scripts/verify-desktop-coverage-ratchet.mjs \
  --baseline <reviewed-platform-baseline.json.gz> \
  --coverage <coverage-final.json> \
  --test-results <vitest.json> \
  --run-receipt <native-run-receipt.json> \
  --source-root <this-checkout/packages/desktop>
```

Missing any input, platform mismatch or an absent reviewed baseline is a failure,
not an optional warning. The two adopted platform baselines are mechanical
derivations of preserved measurements, not native success receipts. Their
original exits remain 1, and the separate configuration adoption does not claim
a new measurement. See the [migration review](release-1.9.15-coverage-migration-20260909.md)
for source reconstruction limits, hashes and current release blockers.

## Raw mapper edge cases and non-flaky observations

AST source-map end-of-line columns use Infinity, serialized as JSON null. The
verifier accepts only this end-column sentinel and binds it to the actual line
end. An implicit `if` false arm can have empty locations; it still contributes a
branch and binds to its enclosing `if`. Neither is dropped from the denominator.

The installed `ast-v8-to-istanbul` computes a missing else hit as
`parentHits - trueArmHits` (`dist/index.mjs` around lines 529–548). Real Windows
EnterpriseAdministrationPanel line 114 has `[1,-1]`. A controlled synthetic V8
range test through the installed actual mapper reproduces `[1,-1]`. Istanbul's
branch totals count only hits > 0 as covered. The verifier follows that rule for
finite safe integers, retains the original raw negative number unchanged and
reports `anomalies.negativeBranchHits`. NaN, Infinity, null and fractional hit
counts remain errors. A negative arm cannot count as covered or hide a newly
uncovered site.

Two actual Windows reports differ as follows:

- server-manager line 1014, the Feishu-enabled logging ternary: `[3,0]` versus
  `[0,3]`. This checks existence of a credential filename under the test's home.
  One run inherited home and the newer run isolated it. Do not call this pure
  worker randomness or use real-home-derived coverage as an isolated baseline.
- SkillZonePage line 139: implicit stale-review-response arm, 0 versus 1. This is
  an async generation guard whose observation depends on response/cleanup order.

No global tolerance is implemented. Before baselining, prefer deterministic
isolated tests that explicitly exercise both cases. If multiple observed maps
are explicitly approved as a platform envelope, retain every original hash and
the exact varying sites. The current v1 schema represents a single observation;
it deliberately rejects simply stitching a max-count baseline with an invented
uncovered-site list. A reviewed multi-observation schema would need both the
per-file max count and the union of actually observed site identities, while
still rejecting new sites or increased counts. That policy is not silently
enabled by this change.

## Verification boundary

Infrastructure tests cover same evidence, improvements, missing/new source,
skipped/deleted tests, environment/lock/config mismatch, stale before/after
sources, forged summary success, malformed raw maps, read-only baseline behavior,
unchanged-source map shrinking, equal-count site substitution and native-mapper
negative-hit semantics, partial/empty maps after source changes, ignore-next via
the real AST mapper, duplicate fragments, CRLF/spaces, ASI changes and bounded
gzip input. These are synthetic facility tests, not release business
scores. The summarizer was additionally read-only checked against the new real
Windows 281-file raw map and returned L9,200/S11,366/F3,125/B10,831 uncovered plus
one negative-branch anomaly, matching the actual report. This does not mark that
run accepted; it exited 1 under the function/branch percentages in force at that
historical checkpoint. Removing those percentages later does not rewrite it.

The subsequent real Windows runner invocation
`0008ed95-7cd1-4f75-9147-59a5c075c1f0` records native exit 0 and all 264 files /
2,074 assertions passed, but `gate.status=failed`: a new uncovered lines site in
`src/renderer/components/ParkServicesPlugin.tsx`. Neither native success nor a
passing test summary overrides this rejection. The test agent is investigating;
there is no tolerance increase, automatic baseline update or passing final CI
claim in this checkpoint.
