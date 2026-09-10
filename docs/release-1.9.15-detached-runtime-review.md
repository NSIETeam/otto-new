# Renamed Electron startup correction and single-file coverage review

This review is not publication approval or proof that every historical client can
upgrade unattended. It is limited to PR [68](https://github.com/NSIETeam/otto-new/pull/68).

## Product correction

Source `ad53fc74870953a3b9c942b93c84de382a5a9fe5` changes only runtime identity in
`ServerManager.startDetached`: `process.versions.electron` replaces a test of the
executable filename. Shipped `Otto.exe` and macOS `Otto` must receive
`ELECTRON_RUN_AS_NODE=1` and the packaged SQLCipher binding. An ordinary Node binary
under an `electron-tools` directory must not be mistaken for Electron.

The explicit operator binding remains preferred. Spawn argv/no-shell behavior,
endpoint validation, timeout, fallback and shutdown policy are unchanged. The
unused `nodeExec` declaration was removed and the outdated header corrected.
Four regressions failed on the old implementation and passed after the fix;
all 27 focused tests, three Desktop typechecks and the touched-file lint passed.
The old test bytes remain identical after removing the added describe block.

## Windows observation and review

Actual native run `c5459e9e-ffbc-42fc-94f3-357df8c19b6c` ran on Windows x64 with
Node 22.23.1 and Vitest/coverage 4.1.11: 265 test files, 2113 assertions passed,
none failed/skipped, native exit 0. **The original mandatory gate failed** because
the AST structure changed. That original receipt is retained, not rewritten.
It ran before ad53 was committed; all 546 recorded Desktop source/test before/after hashes were
captured. Those source/test bytes independently match the subsequent ad53 Git
contents. This is not relabelled as a historical clean-HEAD run.

| Evidence                 | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Native receipt           | `4adf6db91c432b4ddee2f91f3efcff70f9c7a0965d0bad9aa1f2ddc8db6be06e` |
| Original coverage JSON   | `d45a66b72338533333d6b6dbe3cf182c0254a8ab05ea55c6063fa72f13fdadee` |
| Original test JSON       | `1cd531ab756629003c8e18ec93d6bef1a70a1e2f55944f65a0516d3fd199a19f` |
| Changed source bytes     | `6f07e690fbf4f788c5af06cca5dd0482846cbff75afd6e453c211dbee17c6284` |
| Changed test bytes       | `a299b636a7588a25dd4850d2d074660a56e458c3f79ff4dd7fc78a0c411d29d5` |
| Independent site mapping | `d4ed9d4a50d820fee8224401c1357b2129906a51505ffc31e1f4435d59578c0f` |

Exact unchanged source spans were matched against the old actual coverage map,
whose file entry equals the original Windows baseline. 545/546 statements,
65/66 functions, 328/330 branch arms and 510/511 lines map to unchanged old spans;
none changed from covered to uncovered. The changed condition, enclosing
function, and two arms have actual hits 8, 8 and `[3,5]`. Removing one declaration
and the old OR expression accounts for the reduced site totals; implicit else
arms are not dropped. Lower missed counts alone are not the review rationale.

## Revision boundary

Only the `src/main/server-manager.ts` entry in each platform baseline may be
revised after that platform's actual measurement and source review. The other
280 entries, old test inventory, environment, historical review, derivation and
earlier file updates remain JSON-equivalent. A separate single-file revision
record binds the original failed native receipt, actual reports, old entry and
review decision. No automatic baseline updater, tolerance, scope exclusion,
ignore hint, threshold change or verifier modification is introduced.

This is AI engineering review under the user's expressly authorized single-person
emergency release procedure, not independent human/double-person approval.

## Remaining boundaries

The child process is injected in the unit tests: they prove environment selection,
not actual installed application startup. An isolated Electron 43.2.0 ASAR/ESM
execution probe also passed, but is not an installed Otto acceptance result.
Actual package, native runtime and upgrade checks remain required.

Existing uncovered paths (absent packaged binding, failed readiness, timeout,
shutdown while waiting, exit/output callbacks) were not modified and remain
recorded debt. These checks do not establish every possible condition combination.

## macOS observation and review

CI [34442872330](https://github.com/NSIETeam/otto-new/actions/runs/34442872330)
actually ran merge `9fb5eb68a57e2eb43475d544e9fe25fb672ed1e1`, whose Git tree
`aa7619afc11a091834742a6e739ba3b72939c91f` equals ad53. Native run
`5088e8a6-4cfa-4b92-afd9-f8032f73dc15` passed 2113 assertions in 265 files with
native exit 0. The original gate and overall workflow still failed on the same
explicit AST review requirement. The raw artifact is `10139032031`.

| Evidence                 | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Original artifact ZIP    | `156d91e2dc94ec08e49e4bbee16a54fe71a94fb166610e52708040a7db5ca018` |
| Native receipt           | `ebcd091fa74e3f74850d18b41c9168ea052fa289c27cffc95536b93001c4e3ce` |
| Original coverage JSON   | `b86379e410dd29bb43d6e97f819437aff10bffef311f078148838815e8a92b83` |
| Original test JSON       | `2488c4c924acc973bef8540114c8eae22d3ff3eb7ce191970bd8c354424dfdc0` |
| Independent site mapping | `954775091d6b9f860d9668e042e68dc2c50473730086bdfce9ba905bf39afe8c` |

The independent comparison uses the actual prior aa81 Mac run, not Windows
observations. Its old file entry equals the old Mac baseline. The same numbers
of unchanged sites map exactly, with zero covered-to-uncovered regression; the
changed condition/function/both arms have hits 8/8/[3,5]. Current Mac missed
counts are L143/S165/F24/B123, versus L148/S170/F24/B129 before. Old absolute line
numbers shift by two lines, so comparing them without the source diff would
incorrectly report losses. The other 280 file entries have no regression.

Both original failed runs remain failed. Subsequent native runs against the
reviewed single-file baseline revisions and final-source CI remain required.

## Adoption and fresh Windows verification

The reviewed entry revisions have been adopted without changing the verifier,
thresholds, scope or the other 280 file entries. Historical top-level provenance
is retained, and the new `fileRevisions` records bind the two separate native
observations and explicit AI review (not independent human approval).

- Windows baseline SHA-256: `67efac81df897d896806aefe81c8b515dbc0dc18fea23166c7baa2c569586a17`.
- Darwin baseline SHA-256: `ed7ac3928a6bf2b894b6218a582c91f62ef86c913cf3101e972d9c2c41b78159`.
- New Windows native run `7d65cc4b-d24e-444c-aa82-a020a330f535`: 2113 passed,
  none failed/skipped, native exit 0 **and original mandatory gate passed** for
  all 281 files. Native receipt SHA-256
  `f8883a6244d4def2623a9366f34a13918ecb465646cef58776f0b518f0f302d5`,
  raw coverage `5c408a89feb188f119cc0c46eda4a57bc48b71e81cb78e971916a6f75edb8699`,
  test JSON `9eeae67d417af3d6420fe9f5e8293497a3f2ac3a26bf34c92793973a6d949bf7`.
- The unchanged ratchet/runner/CI evidence facility tests passed 95/95.

Final-source Mac CI, all native build checks and the actual release pipeline
remain mandatory. The prior Windows SQLCipher CI failed while downloading
Electron (after SQL compilation), so it cannot be counted as successful.
