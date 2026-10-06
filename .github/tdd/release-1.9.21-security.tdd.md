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
- `cacab65b` RED: BSD `head -c 0` reproduced one failure / nine passes on
  the actual upload helper. GREEN: the empty prefix is explicitly hashed as
  an empty stream; non-empty byte ranges, exact identity, receipt checks and
  three-attempt bounds are unchanged. All 31 upload/workflow assertions pass.
  Cloud run `37494806678` retained the corresponding native macOS failures;
  a new full current-head run is required, not an exemption or rerun of stale
  code. The preceding Bash 3.2 fixture uses the production pinned SSH options.
- `e17ec643` RED: the scoped 1.9.21 evidence test executed 11 assertions,
  with six expected failures against the unchanged 1.9.20 baseline. Both
  original native measurements had already passed 2,249 assertions each.
  GREEN: only the dependency-lock identity and the two displayed preview
  version literals' measured entry were refreshed from each platform's own
  receipt. The same evidence target and unchanged runner/ratchet regression
  targets passed all 103 assertions. The historical review chain, 282 other
  file entries, required tests, metrics, hints and global thresholds remain
  unchanged. This limited refresh was explicitly authorized after both raw
  platform runs and candidate-baseline differential checks passed.
- `006be094` RED: the newly published MCP advisory was reproduced using the
  installed SDK's schemas and synthetic stored credentials only: four failures
  and 26 passes. GREEN: SDK 1.31.0 preserves the issuer in both token and client
  information schemas; all 30 assertions passed under Node 22.23.1. The root
  override, direct core declaration and four lock fields changed; dependency
  edges did not. The existing MCP connection, network guard and OAuth targets
  passed all 97 assertions; core typecheck and code-map check also passed.
  The live release dependency audit returned no advisories. New original native
  Windows and macOS measurements and a separately authorized lock-only review
  remain required before the final full CI and release.

The upstream SDK advisory is
[GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h).
Inspection found Otto uses its own OAuth provider and guarded HTTP transports,
not the SDK `authProvider` credential store. These regressions prove the fixed
SDK schema behavior and unchanged Otto test contracts, not a complete OAuth
attack assessment or first-party credential migration. No real credential was
used or authorization server contacted. The initial default-runtime doctor
used Node 24; the direct Node 22 doctor could not spawn the local npm command.
That local launcher failure is retained, not counted as a passing Node 22
doctor. Tests and typecheck above explicitly used the installed Node 22 binary.

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

The original macOS run `7667cabb-b815-4ba5-b886-e405018de144` in cloud CI
`37496022953` likewise passed all 2,249 assertions in 271 files and exited 0;
its gate rejected only the previous lock/source environment. Both raw failed
gate records are preserved by the corresponding 1.9.21 platform reviews.
The updated gzip identities are Windows
`af5e6ef103449d1e9db84846a502ea9db097398be3807d7001af89a91ad3e598`
and macOS `e0399fd7a0b9d38a55b97cdf25a848552f86a4cdfab9892f9e26f0c91dec8f8b`.
A subsequent Windows run `7aaebfd6-9b98-4780-9067-1fdf0f805912` lost its
execution session without a final receipt. Its partial logs remain retained;
it is not counted as a successful test or substituted for a completed run.

At branch `9b7a2789`, cloud SQLCipher and actual systemd upgrade checks passed;
macOS script CI exposed GNU `stat -c` portability and native packaged acceptance
was not green. These are not evidence for the final current head. Fresh full
CI, current-platform coverage reviews, final artifacts, installation/upgrade,
current security/license checks, and production receipt/canary checks remain
mandatory before announcing a completed release. Paid-model quota is exhausted;
no additional model call is implied or made by this repair.
