# 1.9.15 coverage measurement migration review

**Implementation and baseline adoption recorded; not release approval.** The
mandatory runner is wired into Desktop `test:coverage`, CI and release quality
gates, and the two reviewed platform baselines are adopted. The latest Windows
run has native exit 0 but fails the per-site gate; new clean GitHub CI has not
run. The original failed coverage runs remain failed; this document does not
retroactively change their exit status.

## Decision and boundary

The release security audit requires upgrading the unsupported Vitest 3 line to
Vitest/coverage 4.1.11. V4 uses AST-based source remapping. In a never-imported
fixed fixture, the old mapper reported synthetic function/branch hits (1/1),
while both the V3 experimental AST mapper and V4 correctly reported 0/3
functions and 0/6 branches. See the original reports and limitations in
[the measurement design](desktop-coverage-ratchet-design-20260909.md).

The reviewed historical Windows and Mac reports both include all **281** Desktop
business source files. The original **263** test files are retained; the new
native SQLite regression adds one test file containing two assertions. This is
not a business code deletion, coverage-scope exclusion or measured quality gain.

The implemented migration retains the existing **62% lines and 62% statements**
gates. It replaces the no-longer-comparable 65% function / 74% branch gates
with mandatory per-file uncovered-count and source-site checks, using reviewed
actual V4 platform observations. No arbitrary new passing percentage, global
tolerance or automatic baseline update is authorized. Missing observations are
not passing observations. Existing untested entry points remain recorded as
coverage debt, not excluded from the denominator.

This check cannot establish that assertions truly prove every business behavior.
It complements, rather than replaces, tests, native runtime checks, real
PostgreSQL tests, GUI acceptance, package inspection and production canary.

## Historical measurement evidence

Source: candidate `fd7ef0d2f29437538d2edd80d2c43d9a213a88fe`; actual Mac PR merge
`8d6ca99049ce9b3041b159bb6b342cae2e035f1e` has the identical Git tree
`150e3be5ac775893279fe4ab5fec00bcc9aac002`.

| Measurement                                    | Actual assertions        | Native result                          | Raw coverage SHA-256                                               |
| ---------------------------------------------- | ------------------------ | -------------------------------------- | ------------------------------------------------------------------ |
| Windows x64, isolated home, 2 workers          | 264 files / 2,073 passed | Exit 1: old function/branch thresholds | `4201f402c6a3f037a77f814b82c807019622e1ad9025a27bd2d9adbbd64b0942` |
| Mac ARM64, CI 34334137538, PG17.11 provisioned | 264 files / 2,073 passed | Exit 1: old function/branch thresholds | `b2197b3164870ae0a11ea3f32dff9fc5529ac6b9a8778318d63cdeaa494c67e8` |

Windows raw counts: lines 19,459/28,659, statements 21,804/33,170,
functions 5,168/8,293, branches 17,675/28,506. Mac reports 67.89% lines,
65.73% statements, 62.31% functions and 61.99% branches. No sum is used to
hide a per-file regression.

The Mac artifact archive SHA-256
`bda32e137f6d6d4906b304ac373807cdf507cbc448a86cee5632b933f63ab8d1`
matches GitHub artifact `10097667282`'s digest. The complete **GitHub CLI job
log**, SHA-256 `37ccd660ef4906d95cee531a9a422d9db3d3e2c1d9b7b191a149367daeaaeff2`,
records the passing assertions and coverage failure. It is not a Vitest JSON
report and must not be represented as one.

Historical runs did not capture a complete pre/post-test whole-workspace
fingerprint. Git source association is useful evidence, not proof that every
working-tree input remained unchanged. The new runner must bind its own actual
source/test/config/lock inputs before and after execution, retain raw reports
and the real child exit code, and reject stale reports. It does not make an old
missing snapshot appear retroactively.

## Adoption and subsequent execution

The two gzip baselines, their original source manifest and explicit
`adoption.json` are in `config/test-baselines/desktop`. Independent mechanical
comparison against the final derivation drafts found only `status` and
`review.adoption` changed: all 281 file maps/counts/sites and the 264-file test
inventory are identical. Both historical native exits remain 1. The source
manifest SHA-256 is
`4e146521ad6e18a974d85a28ff43d9b1f74a0e0080df090bd2770849c4165754`.

The reviewed current configuration SHA-256 is
`194406480ef8731bffc98159cd7a3484c6a16e8e995d0bc2b73a7acd6b20da26`.
The historical configuration is separately identified by its candidate Git
bytes; its missing historical Windows working-tree hash is not fabricated.
Adoption is a measurement-migration decision, not independent human release
approval or a substitute for a new native run.

Chronology after the original measurements:

| Checkpoint                                                | Actual outcome                                                                                                                                                                                                              | Boundary                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserved Mac PR CI `34334137538`                         | Core: 224 files passed / 1 skipped, 3,013 assertions passed / 19 skipped. Real PostgreSQL 17.11 Server: 386 files passed, 3,063 assertions passed / 1 skipped. Desktop: 264 files / 2,073 passed; old coverage gate failed. | Overall CI failed. These results belong to the original candidate, not the later runner/configuration/test edits.                             |
| New Windows runner `0008ed95-7cd1-4f75-9147-59a5c075c1f0` | 264 files / 2,074 assertions passed; native exit 0; per-site gate **failed**.                                                                                                                                               | Newly uncovered lines site in `src/renderer/components/ParkServicesPlugin.tsx`; investigation is ongoing. Native success is not gate success. |
| New GitHub CI for adopted wiring                          | Not run at this checkpoint.                                                                                                                                                                                                 | Must execute the final candidate; old reports do not cover later test assertions.                                                             |

The new Windows raw coverage SHA-256 is
`9db62ab1aef13efc331775adde1d874e2be2131188f6cc830097fbdce1523790`;
its actual Vitest JSON SHA-256 is
`0632b3be50aff00dd2442226254272d4246b54e89f5d83a43f346bb9e3933a78`.
Its receipt and reports are retained under
`packages/desktop/coverage/desktop-runs/0008ed95-7cd1-4f75-9147-59a5c075c1f0`.
The new 2,074-assertion result does not revise the historical 2,073-assertion
reports or excuse the new gate failure.

## Regression and review requirements

- A failed, skipped or empty test suite, missing source observation, changed
  tool/config/lock environment, nonzero process exit or incompatible platform
  baseline must fail the current gate.
- Replacing a real coverage map with empty maps, shifting a missed branch to an
  identical-looking different location, or trading newly untested behavior for
  covered trivial code must not produce automatic approval.
- Source-format-only changes should not create invented business differences;
  structural changes that cannot safely reuse evidence require baseline review.
- The late Skill-review response now has an explicit deterministic regression:
  leaving review for the market must preserve current market content when the
  old response arrives, and revisiting review must load the new response.
  This is test-only; no product source was changed for this measurement repair.
- Baselines are review evidence only. They must not enter an installer, user
  runtime or server package. Repository evidence size remains separately counted
  and documented; installer size limits do not change. The adopted evidence is
  2,996,302 bytes (about 2.86 MiB); the documented source ceiling is now 47 MiB
  and the separate checkout doctor ceiling is 55 MiB. These are repository
  budgets, not larger installer allowances.

## Before merging or releasing

The rejected site was traced to an asynchronous test that treated the first
mount's completed IPC request as proof of the remount's reload. The test now
waits for the reloaded ticket and unread counts, with three additional cases for
read timestamps before, equal to, and after the reply. All 65 focused park
service cases pass; actual line 148 and its enclosing false arm are now observed.
Product code, baseline maps and gate rules are unchanged. The second complete
Windows run `dc842ac3-b59f-4727-8602-b4a778de5bdb` then passed all 2,077 tests
with native exit 0 but correctly rejected a separate, previously incidental
equal-file-mtime comparison in account synchronization. Its coverage SHA-256 is
`560d7692ca72cbb0f18c7c08a1390ca5302b926e4711b8647fe20bee9d0b519c`.
The new real-filesystem test explicitly fixes file modification times and
checks newest-file priority, deterministic equal-time ordering, the 8 MiB
payload limit, hashes and preservation of files omitted from the upload.
All six focused account-sync cases pass. A complete scan of the three retained
maps identified no other newly uncovered baseline sites; this is not a guarantee
against all future timing variation. Neither baseline nor gate was relaxed.
Another complete Windows run and the final-source Mac CI are still required.

The third Windows run `5ccdcde5-5e5a-44c4-bae9-809266a87b0d`, source `ab37d5b3`,
completed with native exit 0, all 2,078 assertions passing, and the mandatory
gate passing for all 281 business files. Raw coverage SHA-256:
`bf71b24dc8f33a43939aea8e2736b4f45ae04d450bb591f917dc6037cf7d5009`.
Receipt SHA-256: `674d4d37950d501976a655df5dd34a0d0d92ad7569c14741e37b25ff4596e7de`.

Separately, the older `2701c9f0` Mac CI `34340203305` failed one assertion:
the test's `protected:`-prefixed Base64 double happened to contain the short
substring `Bob`. It had 2,076 passing tests and one failure; native exit 1 and
missing coverage output are preserved, not represented as complete coverage.
A small fixed JSON fixture reproduces the false rejection without private
material. The test now checks that the complete expected trust record reached
the protection callback and that exactly its protected result, not plaintext,
was persisted. All 14 focused E2EE cases pass. This double is not a proof of OS
encryption, and the observed substring was not proof of a production leak.
The final source containing this assertion repair still requires its own CI.

The runner/wiring and reviewed baseline import are implemented. Resolve the
actual `ParkServicesPlugin` site rejection without hiding the missed observation
or weakening the gate, rerun the full Windows suite, obtain clean Mac CI for the
final candidate, and finish required independent checks. Only then can the next
formal release attempt be dispatched.
Previous run `34326917530` failed before publication; it must not be rerun on its
old source. Production is still on 1.9.14 at this review.
