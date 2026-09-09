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
source-like budget is now 44 MiB; doctor is 52 MiB. Existing excluded generated
directories, the 300 KiB individual-text guard and 100 KiB duplicate detection
are unchanged. A focused regression checks the exact source ceiling and rejects
one byte over it. Reassess unexpected subsequent growth instead of incrementing
these limits automatically.

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
