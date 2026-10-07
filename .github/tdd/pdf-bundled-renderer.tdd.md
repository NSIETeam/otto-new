# Bundled basic PDF repair — 2026-10-07

## Scope and journeys

Derived from the user's request to repair PDF after mixed-file delivery exposed
missing Typst. No release/version mutation is part of this change.

- Generate report/article/letter/resume/table PDF on desktop without Typst/Pandoc.
- Generate basic slide PDF without Marp; retain explicit slide page breaks.
- Export edited PDF using the same host renderer, without Python.
- Disclose basic layout and unsupported images/custom templates, not premium layout.
- Cancellation, renderer failure, malformed output and disk-full must not publish
  incomplete edited output or truncate the existing document.
- Reuse bundled Chromium with scripts, remote/local subresources, permissions,
  Node integration and popups disabled; never forward credentials/user settings.

## TDD checkpoints

RED `ae445418`: `pdfFallback.integration.test.ts`, 14 tests, **10 failed / 4 passed**.
The intended missing-engine failures compiled and ran. The edited-output test
also reproduced bypass of the proposed shared renderer. Production was unchanged.

GREEN `607c3768`: same initial target **14 passed**; combined original document
and editable-document suite **64 passed / 2 existing skips**.

Actual Chromium execution then exposed an entry bug absent from mocks:
Electron sets `require.main` to its bootstrap, so `require.main === module`
did not start printing. The initial real smoke timed out after 45 seconds.
The corrected entry compares the explicit argv script with `__filename`.
The failed run is retained in local diagnostic history, not described as a pass.

Follow-up tests cover hard child deadlines and atomic edited-PDF publication.
The final PDF integration target is **20 passed**. All current-task checkpoint
commits are preserved on the repair branch; no squash/rewrite is needed.

## Commands actually run

Runtime: Node 22.23.1, npm 11.13.0, Vitest 4.1.11. Commands below use `node`
as shorthand for that verified Node executable, not the host's default Node.

```text
node <npm-cli.js> run doctor
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/desktop/tsconfig.main.json
node node_modules/eslint/bin/eslint.js <all touched TypeScript files>
node scripts/generate-code-map.mjs --check
git diff --check

# packages/core
node ../../node_modules/vitest/vitest.mjs run src/tools/pdfFallback.integration.test.ts src/tools/generate-document.test.ts src/utils/editableDocument.test.ts src/services/documentCommand.test.ts src/core/kernelBoundary.test.ts --coverage.enabled=false
node ../../node_modules/vitest/vitest.mjs run src/tools/pdfFallback.integration.test.ts --coverage.include=src/services/desktopPdf.ts --coverage.thresholds.lines=80 --coverage.thresholds.statements=80 --coverage.thresholds.functions=80 --coverage.thresholds.branches=80

# packages/desktop
node ../../node_modules/vitest/vitest.mjs run scripts/packaging-contract.test.mjs src/main/pdf-renderer.test.ts src/main/server-manager.test.ts --coverage.enabled=false
node ../../node_modules/vitest/vitest.mjs run src/main/pdf-renderer.test.ts src/main/server-manager.test.ts --coverage.enabled --coverage.include=src/main/pdf-renderer.ts --coverage.thresholds.lines=80 --coverage.thresholds.statements=80 --coverage.thresholds.functions=80 --coverage.thresholds.branches=80
```

Initial direct doctor invocation did not find npm's Windows shim; the real npm
CLI invocation above passed all doctor checks. No global PATH or gate changed.

## Evidence and limits

| Guarantee | Evidence | Status |
| --- | --- | --- |
| Engine-free fallback, syntax, cancellation, old-file preservation | core PDF integration, 20 tests | PASS |
| Isolated host, deny-all subresources/permissions, exit/deadline behavior | desktop PDF tests, 6 tests | PASS |
| Embedded/detached capability wiring and package inclusion | server-manager + packaging-contract tests | PASS |
| Core runtime boundary, document tools and process-tree cancellation | focused core regression | PASS; existing skips retained |
| Chinese report generated five times using actual bundled Chromium version | compiled source smoke, synthetic materials | PASS |
| Edited PDF, slide PDF, cancelled running child | compiled source smoke | PASS |
| Text + layout | pypdf readback; Poppler-rendered all 3 report, 2 slide and 1 edited pages visually reviewed | PASS |
| Complete new installed Windows/macOS package and upgrade | not rebuilt or published in this task | NOT TESTED |
| Real-model natural-language planning for PDF | no paid model calls or customer data in this task | NOT TESTED |

Targeted new-service coverage (not whole-repo coverage):

- Core PDF: statements **98.92%**, branches **95.52%**, functions **92.85%**, lines **98.63%**.
- Desktop PDF: statements **97.77%**, branches **92.30%**, functions **100%**, lines **97.29%**.

No new packages, downloads or dependency-lock changes. No production settings,
user identities/keys, published release bytes, approval protections or secrets
are changed. External custom/image PDF engines remain supported and their errors
are not silently converted into success. Basic PDF intentionally renders image
descriptions only. It is not arbitrary HTML/browser automation or PDF form editing.

Implementation reuses the installed Electron browser, following its official
[printToPDF contract](https://www.electronjs.org/docs/latest/api/web-contents/#contentsprinttopdfoptions).
Security review drove text-only HTML, deny-all resource interception, isolated
session/profile, credential-free child environment, and staged publication.
TDD and PDF visual inspection drove the entry correction and actual Chinese/page
readback checks. Private local diagnostic receipts are not committed to the public repo.
