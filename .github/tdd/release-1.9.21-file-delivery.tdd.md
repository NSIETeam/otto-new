# 1.9.21 spreadsheet and file-delivery regression evidence

The user expanded acceptance beyond Word to other delivered file formats.
Journeys: receive a real Excel workbook, continue exporting after three turns,
see genuine failures rather than successful steps, and preserve old files on
failure or cancellation. No dependency, model budget, release gate or coverage
baseline changes are part of this repair.

## RED / GREEN checkpoints

- `177fb4b`: eight focused tests executed and failed against unchanged production
  code. Missing engines and invalid parameters resolved normally; cancelled CSV
  pivots were written; CSV/JSON could not export without DuckDB; legacy XLS was
  copied without conversion; errors and disguised output formats were accepted.
- `21d36bc`: the same eight tests plus 34 existing data tests passed (42 total),
  after typed failure propagation, cancellation checks and bundled XLSX export.
  CSV is explicitly decoded as UTF-8, avoiding mojibake in Chinese cells.
- `777408e8`: two additional tests executed and reproduced plain text disguised
  as XLS/XLSX being silently accepted. The other eleven delivery tests passed.
- `92834e2f`: all 47 focused tests passed after workbook container validation.
  Final core typecheck passed. TDD checkpoint commits are retained, not rewritten.

An initial test-only fixture used SheetJS ESM file IO without its Node filesystem
binding. The fixture was corrected to buffer IO before the first RED checkpoint;
that setup failure is not counted as product-defect evidence.

Actual focused command (Node 22):

```text
node node_modules/vitest/vitest.mjs run src/tools/analyze-data.delivery.test.ts src/tools/analyze-data.test.ts
```

Run in `packages/core`: 2 files, 47 tests passed, no focused skips. Core
`tsc --noEmit`, touched-file ESLint, `git diff --check` and code-map validation
passed separately. The full local core run then passed: 227 files passed,
1 previously skipped file; 3,071 tests passed, 27 existing platform/fixture skips,
zero failures (Node 22, 111.61 seconds). No skip was added by this repair.
Full core coverage is 53.34% statements / 46.23% branches / 54.64% lines; this is
the measured whole package, not an invented 80% result. Fresh exact-source cloud
CI and actual installers must still pass before release.

## Guarantees covered

| Guarantee | Test target | Result |
| --- | --- | --- |
| Engine failure and invalid parameters reject, not successful ToolResults | delivery tests | PASS |
| A pre-cancelled CSV pivot creates no final file | delivery tests | PASS |
| CSV/JSON export produces parseable ZIP/OOXML XLSX without external binaries | delivery tests | PASS |
| UTF-8 Chinese cells, quoted commas and special characters survive export | delivery tests | PASS |
| Legacy binary XLS is converted rather than merely renamed | delivery tests | PASS |
| Malformed input preserves source and existing destination | delivery tests | PASS |
| Disguised input/output formats are rejected | delivery tests | PASS |
| Five consecutive mixed CSV/JSON exports work in one tool instance | delivery tests | PASS |
| Existing XLSX sheets and formula cells survive export, source unchanged | delivery tests | PASS |
| Existing SVG chart and CSV pivot behavior remains covered | existing data tests | PASS |

## Boundaries

The source tests do not establish installed-package, real-model planning, UI
rendering, arbitrary spreadsheet fidelity or every format's availability.
Macros, legacy text/HTML files named `.xls`, and arbitrary JSON structures are
not claimed as XLS conversion. PDF/HTML generation, generic office conversion
and advanced slide rendering have distinct runtime prerequisites; missing
components must be reported as unavailable rather than fabricated success.
Actual-package mixed-format acceptance remains required in addition to the
existing packaged Word, UI, install/upgrade, identity and history checks.
