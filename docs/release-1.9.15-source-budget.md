# 1.9.15 source budget review — 2026-09-09

This is an explicit repository-source budget revision, **not** a relaxation of
installer size, package hygiene, signature, or native-runtime acceptance.

The integration combines candidate `49d02bcc` and colleague branch
`e7cf417da63b331d96099a0eb5d634f9fc2b2654` (37 commits since their merge base).
Before subsequent release fixes, the source-like report measured 42.51 MiB
against its old 35 MiB ceiling; the independent whole-checkout doctor measured
49.96 MiB against 50 MiB. These count different roots/extensions.

Measured changed-file inventory (not cumulative repository totals):

| Category | Files | New bytes | Previous bytes |
| --- | ---: | ---: | ---: |
| Retained verification evidence, screenshots and logs | 492 | 6,821,760 | 0 |
| Design/history documentation | 46 | 1,036,764 | 20,915 |
| Functional source | 162 | 3,419,771 | 2,436,701 |
| Tests | 107 | 1,080,153 | 659,153 |
| New UI images | 3 | 271,665 | 0 |
| Other changed inputs | 14 | 1,225,223 | 1,074,090 |

The increase includes carpool, marketplace, enterprise matching and associated
evidence. We retain the feature code and review evidence rather than deleting
them or excluding the evidence solely to pass the previous ceiling. The
source-like budget at that checkpoint was 44 MiB; doctor was 52 MiB. Existing excluded generated
directories, the 300 KiB individual-text guard and 100 KiB duplicate detection
are unchanged. A focused regression checks the exact source ceiling and rejects
one byte over it. Reassess unexpected subsequent growth instead of incrementing
these limits automatically.

## Reviewed AST measurement evidence increment

The separate Vitest 4 measurement migration retains two raw-derived reviewed
platform baselines, rather than hiding untested functions or deleting evidence.
Their gzip sizes are **1,323,532 bytes** (Windows) and **1,323,709 bytes** (Mac).
The reconstructed source manifest is **347,998 bytes**. The complete baseline
directory also contains the small explicit adoption record. This is review
data, not executable runtime code, a generated installer, or a successful test
receipt. The historical process failures remain recorded.

After this evidence was imported, the source report actually measured **46.21
MiB**, exceeding 44 MiB. Its scope now explicitly includes `config` and `.gz` so
these files are counted; `config/test-baselines` avoids the existing generated
`coverage` directory exclusion. The current reviewed source ceiling is **47 MiB**
and the separate whole-checkout doctor ceiling is **55 MiB**. The exact limit
and one-byte-over negative tests also cover a gzip file in this configuration
directory. No size environment override, additional directory exclusion or
installer allowance was introduced.

This approximately 2.86 MiB evidence increment belongs only to the repository
and corresponding-source archive. Desktop and enterprise package allowlists do
not include it. Windows and macOS installer ceilings below remain unchanged.

Historical `docs/research/carpool-delivery/evidence/*.log` receipts are kept
verbatim, including terminal blank lines and spaces in failure diff excerpts.
A path-specific Git whitespace attribute suppresses only those two whitespace
warnings for raw log files; no application code, test code or other guard is
exempted, and log content is not rewritten to manufacture a passing transcript.

Installation budgets remain separately enforced: Windows 136,421,279 bytes
(previous installer plus 8 MiB), macOS 146,800,640 bytes. These are hard limits,
not target sizes. Windows remains targeted around 125 MB. No source, tests,
build workspaces, debug maps or verification screenshots are authorized in the
user installer. Required runtime libraries and their licenses/notices must not
be removed to meet size limits. Actual package inventory and native loading
checks are required before release; source-size success is not their substitute.
