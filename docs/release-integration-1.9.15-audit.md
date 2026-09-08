# Otto 1.9.15 candidate integration audit

This records source integration and local verification on 2026-09-09, not a
claim that artifacts have been signed, published, installed or migrated in
production. Release operations and platform evidence are recorded separately.

## Authority and branch decisions

The isolated candidate starts at `origin/internal` `9d65ad94`. The reviewed
Agent line `e7d78` is included by merge `c8ef4a32`; its current intent graph,
constraints, policy and recovery behavior are preserved. The historical ledger
anchor remains `1874681db2f108aa6a9b6d47ee62578d4ce37ac2`. Live origin ancestry
verification passed before the final source freeze.

`origin/codex/resident-platform` tip
`9eba7c9564352d1bfbcc202388f60579bf5f9645` contains genuine missing functionality.
It was replayed by reviewed feature hunks, not merged wholesale over the newer
Agent/policy and desktop implementation.

| Source feature | 1.9.15 disposition | Reason / preserved boundary |
| --- | --- | --- |
| Feishu/Lark official device registration, WeCom official QR, DingTalk official QR/Stream | Integrated, with additional regression fixes | Server-owned credentials; token-protected local control; shared durable task/approval/identity machinery; thin Desktop UI and IPC |
| Owner claim/binding, provider scopes, credential persistence, installed-channel restore | Integrated and hardened | Initiator captured before provider I/O; current identity and terminal state rechecked before installation, binding and execution |
| Enterprise URL migration, federation feature detection, UTF-8 message sizing and `OTTO_USER_DIR` isolation | Integrated by companion regression audit | Clears stale auth on endpoint changes; retains central identity and stronger current skill-name validation |
| Sidebar session-menu portal, viewport positioning and Escape focus | Integrated | Preserves newer project-menu and session grouping behavior |
| Stop background park polling after explicit commercial entitlement denial | Integrated | Transient errors still retry; server entitlement enforcement is unchanged |
| Always enter local workspace without formal login (`App` / `internal-test-access`) | Intentionally not replayed, confirmed by release owner | Would change the formal-login product policy and existing enterprise identity boundary |
| Old darwin-arm64 SQLCipher binary/manifest and repository fallback | Not replayed | Current verified native development binding and packaged runtime custody are newer and stricter; no old binary replaces them |
| Older parallel grouping/timestamp/inbox UI lines | No wholesale merge | Newer internal implementations are retained; this audit does not claim every historical branch is an independent required merge |

## Correctness and security fixes during replay

- Feishu cancellation, expiry, superseding registration and account changes are
  terminal. Late QR/status/credential callbacks cannot revive an ended scan.
  Cancelling before QR creation settles the pending request. Credential-save
  callbacks carry a live guard across storage waits and before gateway startup.
- Pairing captures the local user, company, edition, role and enterprise identity
  generation before asynchronous provider registration. Changed identities cannot
  install or bind an earlier user's scan. Approved remote tasks re-resolve the
  active provider identity against the current local account before running.
- Installation verifies its terminal state after audit and credential-commit
  waits. A late credential write after cancellation/expiry is removed before
  runtime startup or later resident restore.
- Official broker polling rechecks cancellation and expiry after provider I/O;
  returned credentials are discarded after termination. Provider authorization
  links are restricted to official HTTPS hosts.
- DingTalk robot messages use the SDK CALLBACK topic, not the EVENT listener;
  only accepted work receives a durable acknowledgement. WeCom timed-out
  connections are disconnected and late messages are ignored.
- The companion runtime audit adds bounded HTTP/JSON deadlines and response size,
  redirect rejection, fixed official HTTPS/WSS origins, encoded tickets and a
  real SDK-connected check instead of trusting a fulfilled connection promise.
- Existing enterprise-managed broker channels remain the default. Official
  channels require explicit composition opt-in; legacy WeCom broker credentials
  are not silently sent to the official runtime.
- Otto branding replaces source-branch ClawMaster defaults. IPC allows only the
  intended channel routes and strictly validated Feishu registration IDs.

## Version, dependency and baseline contract

Product and desktop versions are `1.9.15`; the server package remains `0.1.0`.
The ledger binds Enterprise API 4, schema 26, migration compatibility and the
actual source capability set (including `policy_intelligence_inbox_v1`). Public
`otto-server/recruitment` imports are accepted only as named package exports;
wildcard and source-deep imports remain rejected by the boundary gate.

New SDKs are pinned to `@wecom/aibot-node-sdk@1.0.7` and
`dingtalk-stream@2.1.7-beta.1`, with lockfile integrity entries. The DingTalk
requirement brings the shared locked axios version to `1.20.0`. `packages/server/NOTICE`
preserves the published DingTalk MIT text and records WeCom's MIT declaration.
WeCom 1.0.7 does not ship a separate LICENSE/copyright text; this upstream notice
gap is explicitly disclosed rather than fabricating a copyright statement.

The final official-source license check found no public tags/releases. The
[1.0.7 npm publication](https://registry.npmjs.org/@wecom%2Faibot-node-sdk/1.0.7)
declares MIT and gitHead `ea48edf7c99be0609fe9740050f4942f897a5d95`, but GitHub's
official commit/tree APIs could not resolve that hash (HTTP 422). The inspected
[public repository snapshot](https://github.com/WecomTeam/aibot-node-sdk/tree/80615b987ef69c6028ad764924609247c0725955)
is version 1.0.6, declares MIT in package metadata and README, and has no LICENSE
file in its complete recursive tree. The official LICENSE-path commit history
is empty; the raw LICENSE at the published 1.0.7 hash returns HTTP 404. Thus no
version-matched full permission text or copyright holder could be independently
verified from upstream. NOTICE records these precise limits; it does not treat
another version or another language SDK as a substitute.

The candidate's shared node_modules junction was not installed into or mutated.
SDKs for local tests were installed with scripts disabled in the separate
`D:/otto/otto-release-deps-1.9.15` directory, then exposed by package-local links.

## Verification

- Doctor, whitespace/diff check, package boundaries, generated code-map and
  static integration baseline: passed.
- `validate:integration-baseline --verify-git-refs`: passed against live origin
  using the repository's existing dedicated SSH identity (read-only).
- Baseline/boundary/code-map suites: 3 files, 15 tests passed.
- Final Desktop QR/IPC/ServerManager/Sidebar/Park suites: 10 files, 143 tests
  passed together from the desktop package cwd.
- Server typecheck and production build passed. Desktop main, preload and
  renderer typechecks passed using candidate-built public server declarations.
  The unadjusted desktop command sees stale server declarations through the
  shared checkout junction; no compiler diagnostics were suppressed. A fresh
  dependency installation in release CI must run the ordinary package command.
- Final channel lifecycle suite: 22 files, 132 tests passed after the companion
  runtime audit. Touched-source ESLint, boundaries, integration baseline and
  code-map checks passed again before handoff.

The added `scripts/release-channels.vitest.config.mjs` uses candidate-source
workspace aliases. It deliberately does not inherit script-suite fs mocks:
credential and audit persistence is exercised using real temporary files.
Negative tests were observed failing before fixes for lifecycle cancellation,
late credentials, account switches, callback dispatch, connection cleanup and
installation rollback.

No real provider QR was scanned and no real channel message was sent during
these tests. Provider-account onboarding, installer launch and unsigned/signed
artifact policy remain release acceptance steps, not implied by mock tests.
