# Word runtime fallback and packaging preflight — TDD evidence

## User journeys

No plan file was supplied. These journeys come from the reported missing Python
dependencies, repeated Word failures and the actual artifact-only build log:

- As an Otto desktop user without Python document packages, I can generate a
  real basic Word document repeatedly, with a visible layout limitation instead
  of a nonexistent deliverable or an automatic package installation.
- As a user with the advanced Python engine, I can run the trusted bundled
  script even when it lives inside an Electron ASAR.
- As a release operator, I check clean source size before downloading or building
  native outputs, without increasing source or installer budgets.

## RED and GREEN checkpoints

| Stage | Commit | Executed target | Actual result |
| --- | --- | --- | --- |
| Missing-runtime RED | `b0f962cb` | Core `generate-document.test.ts` and `editableDocument.test.ts` | 5 intended failures, 44 pass, 2 existing conditional skips |
| Archived-script RED expansion | `e3550784` | Same two files | 6 intended failures, 43 pass, 2 existing conditional skips |
| Minimal Word GREEN | `c3a4fe93` | Same two files | 49 pass, 2 existing conditional skips |
| Packaging-order RED | `d5ff2cfb` | `scripts/tests/desktop-packaging-validation.test.js` | 1 intended failure, 7 pass |
| Packaging-order GREEN | `7cab9fcf` | Same script test | 8 pass |
| Native-trigger RED | `b85f86aa` | Same script test, expanded to require both native workflows on packaging changes | 1 intended failure, 8 pass |
| Native-trigger GREEN | `f9bac13c` | Same expanded script test | 9 pass |
| Executor-fixture RED | `f743e389` | Core `nonInteractiveToolExecutor.test.ts`, isolated output directory | 1 intended failure, 9 pass |
| Executor-fixture GREEN | `a9361f7f` | Same target; preserve failing PDF/advanced Word cases and add five real native Word deliveries | 12 pass |

Commands use cached Node 22.23.1 and the owning Vitest configuration:

```text
# From packages/core; RED and minimal GREEN
npx --offline --yes --package=node@22.23.1 node ../../node_modules/vitest/vitest.mjs run src/tools/generate-document.test.ts src/utils/editableDocument.test.ts --coverage.enabled=false --reporter=dot
# From repository root; packaging RED and GREEN
npx --offline --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run scripts/tests/desktop-packaging-validation.test.js --coverage.enabled=false --reporter=dot
```

## Expanded guarantees and verification

| Guarantee | Test or check | Result |
| --- | --- | --- |
| Five consecutive missing-runtime calls produce actual OOXML ZIPs, escaped content and trusted bylines | `generate-document.test.ts` | PASS |
| Name-only identity does not invent a department or accept the caller's login name | Same file | PASS |
| Dependency-check cancellation leaves no final file | Same file | PASS |
| Short-lived missing-dependency cache recovers the advanced engine | Same file | PASS |
| Python receives a real private temporary script path, not an ASAR path | Same file | PASS |
| Advanced-engine error, missing output and empty output still fail | Same file | PASS |
| Heading styles are linked and Mammoth recognizes an actual Heading1 | `editableDocument.test.ts` | PASS |
| Source preflight precedes native download/build; both native workflows revalidate packaging changes; fixed budgets and no publication remain enforced | Packaging workflow test | 9 PASS |

Final expanded core command, from `packages/core`:

```text
npx --offline --yes --package=node@22.23.1 node ../../node_modules/vitest/vitest.mjs run src/tools/generate-document.test.ts src/utils/editableDocument.test.ts src/services/documentCommand.test.ts src/services/bundledRuntime.test.ts src/tools/convert-document.test.ts src/tools/convert-document.recovery.test.ts src/tools/generate-safe-document.test.ts --coverage.enabled=true --coverage.include=src/tools/generate-document.ts --coverage.include=src/utils/editableDocument.ts --coverage.reportsDirectory=D:/otto/diagnostics/release-1920-verification-20261006/word-fallback-coverage --reporter=dot
```

Result: **7 files, 104 pass, 5 existing environment-conditional skips**.
Core `tsc --noEmit`, changed-file ESLint with zero warnings, repository doctor,
code-map check and `git diff --check` passed. Typecheck initially caught the now
unused private `format` parameter; removing it and rerunning passed.

## Coverage and boundaries

All added fallback/cancellation/byline branches and script-staging statements
were executed: cancellation `[1,27]`, fallback `[9,18]`, byline `[6,3]`,
department `[5,1]`, script staging 18 hits. The added styles relationship ran
9 times. New changed paths therefore exceed 80% coverage.

This is not 80% whole-file coverage: the two large pre-existing files together
reported 72.20% statements, 56.36% branches, 82.05% functions and 77.79% lines.
No coverage exclusion, test disablement or ratchet change was added.

Basic Word output supports existing headings/text/bullet rendering, not the
advanced engine's complete tables, themes, cover or official-document layout.
The tool discloses that limitation. No runtime package download was added.
These tests do not prove model planning quality or real installation/upgrade.
Actual final-source installer validation and protected release gates remain
required; no production release was created during these checks.

## Full-suite follow-up

Candidate CI `37441977509` ran all core tests and exposed one older integration
fixture that still expected missing Python to fail DOCX (3061 assertions passed,
1 failed, 20 existing conditional skips). The fixture now exercises a genuinely
unavailable PDF engine with its complete error assertions unchanged. Added
integration cases verify five real native Word outputs, model/UI disclosure and
advanced Python rendering failures still becoming errors with no final output.
No executor production logic or failure propagation was changed.

After that update, from `packages/core`:

```text
npx --offline --yes --package=node@22.23.1 node ../../node_modules/vitest/vitest.mjs run --coverage.enabled=false --reporter=dot
```

Full local result: **226 files pass, 1 existing conditional skipped file;
3059 assertions pass, 26 existing conditional skips (3085 total)**. No assertion
failed. Core typecheck and strict lint of the updated integration test passed.
This is local Windows evidence; the previous failed macOS CI is preserved and
must not be reused as final candidate acceptance.

The previous artifact-only run `37437955587` failed before packaging because
native generated output inflated the doctor source count to 76.70 MB. Its
native builds and attestations passed, but it is not installer acceptance.
The repair moves the unchanged 55 MB source check earlier; it does not exempt
generated content from actual installer or ASAR checks.

Preserve these checkpoints and outcomes in the PR body if squash merging.
