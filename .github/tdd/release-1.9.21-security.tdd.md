# 1.9.21 security and delivery checkpoints

The user authorized one new 1.9.21 after validation, not an overwrite of public
1.9.20. Temporary release credentials/self-review are authorized only after
all mandatory validation succeeds. No such production change has occurred.

## Actual RED/GREEN evidence

- `dd669d02` RED: 23 security assertions, 7 failures on the affected lock.
  `cf65a951` GREEN: pinned shell-quote 1.11.0 / sharp 0.35.5; 29 focused
  assertions passed, live npm release audit reported zero advisories.
- `91fa1d39` RED: the Linux runtime resolver still rejected the fixed closure.
  `42ba512` GREEN: fixed resolver accepted current package identities; 61
  packaging assertions passed, 1 pre-existing platform skip remained visible.
- `133e5406` RED: corresponding-source lock and packaged native proof were
  still bound to obsolete native versions; 2 of 26 assertions failed.
- `83b941c3` RED: a local BSD-stat fixture reproduced the macOS CI failure;
  1 failure / 8 passes. `d064e14d` GREEN: POSIX byte counting retained local
  identity, prefix SHA, exact receipt and three-attempt bounds; upload and
  release workflow targets passed 30 assertions.
- `4378ed56` RED: current native source, Cairo license and notice assertions
  failed (3 failures / 25 passes). `54c41ee6` GREEN: verified sources for all
  five targets, preserved original licenses, new librsvg memory-limit patch,
  and separate native/WASM libheif versions; 93 source/license/native contract
  assertions passed including altered-license and source-integrity rejection.

Commands used installed Node 22.23.1 and Vitest 4.1.11. Upstream archives were
read and hashed, not executed. No shell exploit was executed; quoting tests
inspect parser/quoting behavior only. Source/native code was not rebuilt, so
third-party code coverage and complete native build provenance are not claimed.

## Retained evidence and remaining gates

The actual full Windows desktop run
`48a84839-64dd-4b3a-bf43-8458f6102111` passed **2,249 assertions in 271 files**,
with no pending/failed test. Its coverage gate correctly rejected the old
lock/source environment. Receipts and reports remain intact; no thresholds,
uncovered budgets or required test lists have been lowered. Earlier failed
Windows runs remain retained, including the packaging fixture failure and
subsequent 5-second test timeout.

At branch `9b7a2789`, cloud SQLCipher and actual systemd upgrade checks passed;
macOS script CI exposed GNU `stat -c` portability and native packaged acceptance
was not green. These are not evidence for the final current head. Fresh full
CI, current-platform coverage reviews, final artifacts, installation/upgrade,
current security/license checks, and production receipt/canary checks remain
mandatory before announcing a completed release. Paid-model quota is exhausted;
no additional model call is implied or made by this repair.
