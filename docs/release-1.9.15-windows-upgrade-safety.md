# Windows upgrade acceptance for 1.9.15

The release review found two additional upgrade hazards: `spawn()` could return
before an asynchronous launch error, and the stock NSIS old-version uninstaller
recursively removes its installation directory. A source checkout or user file
mixed into that directory must not be treated as disposable application data.

## Boundaries

- Launch acknowledgement is not installation success. Keep Otto running after a
  known launch failure or unknown startup outcome; never replay an unknown
  installer automatically. Keep argument boundaries, download allowlists and the
  install-time SHA-256 recheck.
- Check both the selected target and the registered old application directories
  **before** old-version uninstall. Changing `/D` cannot make an unsafe old
  directory safe. Reject ambiguous directories without moving/deleting user data
  or rewriting registry state to hide the conflict.
- The new uninstaller also has a preservation guard. This does not modify an old
  executable already installed on a user's device: running that old uninstaller
  directly remains outside the new installer's protection.
- Windows/macOS platform signatures are still unavailable under the user's
  explicit release exception. SmartScreen, Gatekeeper and device policy may
  require intervention or block installation; do not promise unattended updates
  on every historical device.

## Evidence layers

1. Desktop lifecycle tests exercise the actual `UpdateService.installUpdate`
   entry, including asynchronous native OS launch refusal, integrity refusal,
   repeated clicks and unknown outcomes. Other lifecycle cases use a controlled
   child-process event fixture, not a real installation.
2. NSIS fixture checks compile the actual guard against disposable application
   fixtures. No user's application or registry is modified by those tests.
3. The formal release's existing Windows installation job invokes
   `scripts/verify-windows-installer-upgrade.ps1` on the **actual candidate EXE**
   after clean installation. It verifies registered-old-directory preservation
   with a different new target, new-directory preservation, the candidate
   uninstaller's refusal, and a clean same-version in-place upgrade. Only a
   GitHub-hosted Windows runner may execute this script. Nonzero refusal is
   exactly `73`; file snapshots must remain unchanged. Unknown timeouts fail and
   are not killed/replayed. The job retains per-case JSON receipts and then still
   runs packaged SQLCipher/native/application probes.

Local contract tests only establish wiring and workstation refusal. Formal
candidate installer results must come from that actual workflow run, not a
previous release or the contract-test count. Same-version in-place acceptance is
not evidence for every 1.9.x historical installer, enterprise policy or machine.

## Pre-candidate observations (2026-09-09)

- Windows native desktop run `6e9df4f5-e6ee-48e2-8989-a36319eada21`:
  2,100 tests passed, none failed or skipped, including 22 updater regressions.
  Its original receipt retains the coverage gate's explicit structure-review
  refusal; a later baseline review must not rewrite that receipt as successful.
- NSIS guard fixtures: 25 passed, including 23 real compiler/marker-process
  cases. Scripts workspace: 676 passed, none failed, four platform skips.
- These observations do not assert formal installer acceptance, a new macOS
  measurement, a deployment, or an update already delivered to customers.

## Template references

The implementation is based on the locked `app-builder-lib` 26.15.3 templates.
`customInstall` runs after `uninstallOldVersion` and cannot be used as a preflight;
`customUnInit` affects the newly built uninstaller only.

- [electron-builder NSIS custom macros](https://www.electron.build/v26/docs/nsis/)
- [NSIS section execution order](https://nsis.sourceforge.io/Docs/Chapter4.html)

These references explain the insertion points, not proof that a compiled
candidate has already passed the above checks.
