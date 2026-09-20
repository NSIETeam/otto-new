# image-size dependency remediation for 1.9.17

The 1.9.14 unreachable-code exception expired on 2026-09-15 and stopped the
first 1.9.17 release build. It is **not extended**. Its policy, audit snapshot
and expiry regression remain historical evidence, not an active release waiver.

## Resolution and compatibility

- Resolve PptxGenJS's image-size dependency to exactly **2.0.4**, from the
  official npm registry with its pinned SHA-512 integrity. The former 1.2.1
  package and its now-unused queue dependency leave the lockfile.
- Keep PptxGenJS **4.0.1**, its four runtime file hashes, browser barrier and
  workspace consumers unchanged. Its bundled JavaScript does not load
  image-size. A major-version transitive override is acceptable only under
  this explicitly checked contract, not for arbitrary future PptxGenJS builds.
- The installed 2.0.4 ICNS parser rejects entries shorter than their header;
  HEIF/JXL box iteration makes forward progress and bounds malformed boxes.
  Bounded child-process tests exercise zero-length ICNS, HEIF and JXL fixtures
  through both installed CommonJS and ESM entry points.
- Real in-memory PPTX exports contain text, PNG and SVG assets through both
  PptxGenJS entry points. Application document-generation tests additionally
  exercise local screenshot and export behavior.
- image-size 2.0.4 remains **MIT**; the official package includes its license.
  Distribution notices must be generated from the rebuilt dependency tree.

## Gates and evidence

The active release gate now requires **zero live npm audit findings at every
severity**, a complete production/development inventory, the exact repaired
lock graph, the one reviewed root override and the unchanged installed
PptxGenJS runtime. Offline audit snapshots remain forbidden in CI. The same
live gate runs before PR merge so failures are found before release approval.

TDD journey: a maintainer must release repaired dependencies after the historic
waiver expires without accepting old vulnerable bytes or ignoring new alerts.

| Evidence | Result |
| --- | --- |
| RED checkpoint `27f0056e`: focused Node 22 test | Failed at the expired waiver as expected |
| GREEN checkpoint `1ff53061`: dependency gate tests | 29 passed |
| Official live npm audit, 2026-09-20 | 0 findings; 1,656 dependencies reported |
| Real installed CJS/ESM PPTX exports and malformed parser fixtures | Included in the 29 passing tests |
| Historical waiver expiry, altered integrity/graph, unexpected findings and partial/error reports | Rejected by regression tests |

The coverage environment review only changes the lock identity for this exact
two-record dependency diff. All coverage source entries, missed-site budgets,
required tests, configuration and prior provenance are retained byte-for-byte
as JSON values. It is not a new coverage measurement; fresh native Windows and
macOS gates are still required.

This remediation does **not** prove an installer was signed, upgraded, deployed,
or that all customer devices migrated. Those remain separate release gates.
