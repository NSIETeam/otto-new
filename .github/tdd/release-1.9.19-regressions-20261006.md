# 1.9.19 bug-fix candidate: regression and release evidence

Status: **candidate, not released**. PR: https://github.com/NSIETeam/otto-new/pull/87.
The user authorized publication only after validation, with the previously
accepted unsigned-desktop and unknown-legacy-admin-setting exceptions. Temporary
GitHub credential/self-approval exceptions apply only to this validated 1.9.19
run and require cleanup/restoration on either outcome. No other gate is waived.

## Product scope

- Include the internal shared-task/document fixes in `c032fa0f` and their existing
  RED/GREEN record, `shared-mechanisms-20261006.md`: bounded research effort rather
  than the ordinary three-round budget; safe abandonment of settled read-only
  work without losing audit; actual fresh document output and cancellation.
- Include earlier initialization/private-chat fixes in `3b10ac24`. A genuine
  multiple-key identity conflict remains protected, with public device IDs and
  fingerprints for diagnosis; do not delete identities or invent empty history.
- Ordinary and explicitly named expert tasks now share a bounded optional
  enterprise-knowledge lookup with timer cleanup, late-response isolation and
  truthful notices. Its absence is not a statement that all services stopped.

## Additional RED observations

- `9bcad93e`, `4fc2277c`: current locked dependency risk and unpatched recursive
  matcher chains. The patched lock removes those chains rather than extending a
  vulnerability exception. Full official npm audit now reports zero findings.
- `991ccd5f`: successful optional knowledge lookup left its deadline timer alive.
  `089c5f54` and `43aeeec0` fix timer lifecycle and the desktop type contract.
- `f761440c`: old-install crypto tests cannot execute installed Electron 43.2.0
  under the current 43.7.7 host; retain version equality, use separately pinned
  historical fixture bytes on a fresh hosted Windows runner, never ship them.
- `453b154f`: packaged media proof rejected the new pinned runtime; check the
  actual current desktop pin, not an obsolete literal.
- Cloud runs exposed absent old `extract-zip` in current Electron dependencies.
  A local test failed before `historicalHostTools` existed; the implementation
  now loads Electron's declared native extractor and the actual module test
  passes. No network/TLS/ZIP-integrity admission condition was relaxed.
- The new scoped-baseline contract test initially failed because the 1.9.19
  Windows review did not exist. Five source changes and the real dependency
  environment require explicit native evidence review, not an update switch.

## Verification recorded so far

- Current core/server build passed. Desktop main, preload and renderer type
  checks passed using the package's actual three configurations. An earlier
  unqualified `tsc` invocation incorrectly selected the repository aggregate
  configuration and failed; that output is not reported as a successful check.
- Script suite with the Windows evidence assertion: 74 files, 891 passed,
  32 conditional skips. Hosted historical-host/real crypto tests are mandatory
  in CI; local conditional skips do not establish native installation success.
- Focused desktop UI/context regression: 75 passed across three files, including
  late resolve/reject after closure, duplicate load, ordinary/expert knowledge
  failure and preserved draft/history. Historical host tooling: 13 passed.
- Real Windows desktop run `320b9839-ffab-4ae9-82f6-c0ddfd3b0fbe`: 270 files,
  2,234 assertions, native exit 0, unchanged before/after inputs. Original ratchet
  rejection was the changed dependency environment. Its original receipt is
  retained; read-only revalidation after the five-file scoped review passed.
- At candidate `2dcc9abc77bb25069dd7dc69216994c7015bd5c6`, hosted Windows
  historical crypto seed, Linux root deployment transactions, actual systemd
  enterprise-upgrade acceptance, packaged native media and SQLCipher native
  assets passed. Full final-source CI and installer/upgrade gates still apply.
- Official current-lock npm audit: zero info/low/moderate/high/critical findings.
  This is dependency auditing, not a claim that ScanCode/Syft/Trivy/Promptfoo
  have all been rerun successfully on the final installers.

## Six newly authorized actual-model calls

The human approved six `deepseek-v4-pro` calls, maximum 4,096 output tokens each,
fixed synthetic materials only. Exactly six reservations and six HTTP 200
responses completed with `finish_reason=stop`; no paid retry or seventh call.
The actual current Otto model adapter processed a six-round synthetic context.
The first result contained a comparison and all three fixture citations. The
next five outputs were passed to the actual `GenerateDocumentTool` and produced
five fresh Word files, validated as OOXML with their round-specific title and
body. Saved model configuration and the four measured implementation files were
unchanged before/after. Evidence is task-local under `artifacts/live-1919-20261006`
and was moved without modification to the separate task evidence directory,
`D:/otto/diagnostics/release-1919-verification-20261006/live-1919-20261006`.
It is intentionally not committed with any credential or personal configuration.

Reported provider usage totals: 10,385 input tokens, 7,748 output tokens. These
are reported token counts, not a calculated invoice or immutable model revision.

This is an adapter-to-document-tool smoke, **not** a full installed-client Agent
planning run, arbitrary research quality evaluation, commercial signature,
production private-chat acceptance or proof that all enterprise accounts work.

## Old-version upgrade boundary

The old-IP mirror already serves the byte-pinned published 1.9.18 bridge. Keep it
available for 1.9.16 clients whose updater trusts that origin. Bridge 1.9.18
contains the new-IP default and scope-alias migration; it can then obtain 1.9.19
from the new mirror. Never redirect an old client to a host it does not trust.
Release acceptance now tests both 1.9.14 and 1.9.18 installed seeds against the
new installer; the bridge download uses its fixed published byte size and hash.
The historical 1.9.14/1.9.18 host is test-only, not a deliverable dependency.

Earlier GitHub-only clients still need GitHub access or a preserving installer
upgrade. Offline machines cannot update until reachable. The two-stage route
does not imply that the old server can be retired before old clients migrate.

## Remaining release conditions

The matching macOS ARM64 final-source native run also passed all 270 files /
2,234 assertions (run `15a610b3-5f15-402f-9d23-663b045783d6`, CI 37415136657,
artifact 11391476295). Its original environment rejection remains preserved.
The separate macOS review uses only that actual platform's reports. Exactly 278
unrelated baseline entries per platform are retained byte-for-byte in the parsed
object, with their canonical digest recorded; no global tolerance is introduced.

Final-source CI after the scoped reviews, installer size, original and
bridge installation upgrades, DPAPI/device/MLS/history/outbox continuity, update
trust and rollback, signed enterprise package, new-server canary/deployment,
public mirror compatibility and the release-preflight smoke checks must finish
before claiming delivery. No tag, public release or production deployment is
implied by the results recorded above.
