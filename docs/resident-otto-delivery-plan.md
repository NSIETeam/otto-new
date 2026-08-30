# Resident Otto Delivery Plan

Status: implementation plan and release contract

Scope: Desktop UI, channel onboarding, durable scheduling, RPA, and remote task control

Kernel boundary: `docs/runtime-kernel-boundary.md` remains authoritative

## Outcome

Otto becomes a low-load, restart-safe local coworker that can stay resident for
days, accept authenticated work from Desktop, Feishu, Lark, and WeCom, execute
long workflows and controlled RPA, and explain every permission, cost, external
write, pause, recovery, and failure to the user.

The work is delivered in independently reviewable stages. A stage is complete
only when its implementation, focused tests, negative tests, user-visible state,
and release evidence all exist.

## Non-negotiable product rules

1. Personal installations make no paid or external calls while idle.
2. Background model use is disabled until the user explicitly enables it.
3. Renderer exit never silently abandons or continues work. The user chooses.
4. Long work is represented by durable runs and steps, not process-local
   promises, chat history, or an unregistered timer.
5. Every external write has an idempotency key and a persisted commit state.
6. An interrupted write becomes `unknown_outcome` until reconciled or taken
   over by a person. It is never blindly replayed.
7. A chat message cannot directly become a shell command or raw mouse action.
8. RPA, channel adapters, marketplace code, and Desktop UI remain outside the
   runtime kernel and enter it through versioned capability contracts.
9. Secrets are stored in the platform credential vault and never placed in QR
   payloads, ordinary configuration, logs, screenshots, or model context.
10. All user-visible outcomes use typed status and audit events; raw backend
    errors are not product copy.

## Track A: right-side module visual system

### A1. Asset inventory

Create a generated inventory for every icon rendered by `ModuleWorkspace`,
`RightPanel`, module launchers, expert cards, connection cards, and empty-state
actions. Classify each asset as:

- registered semantic SVG;
- branded integration mark;
- generated raster image;
- emoji or text glyph;
- inline unregistered SVG;
- fixed-color or theme-aware.

The inventory is a CI artifact and fails when an unclassified production icon
is introduced.

### A2. `OttoIcon` contract

All ordinary module icons use one component and one registry:

```ts
interface OttoIconDefinitionV1 {
  name: string;
  category: 'module' | 'action' | 'status' | 'brand';
  viewBox: '0 0 24 24';
  decorativeByDefault: boolean;
}
```

Ordinary icons use `currentColor`, a shared optical box, rounded line caps,
theme tokens, and no embedded light background. Brand marks may retain official
colors only on channel connection surfaces. Emoji, arbitrary text initials,
per-card hex colors, and raw SVG markup are prohibited in the right rail.

### A3. Visual acceptance matrix

Capture Workbench, park services, office tools, experts, custom modules, group
menus, add-module dialogs, and connection cards under:

- light;
- dark;
- follow-system in both system appearances;
- increased contrast;
- 100%, 125%, and 150% scale;
- keyboard focus and reduced motion.

Automated contracts reject undefined legacy theme variables, fixed blue
fallbacks, raster/emoji module marks, clipped labels, and missing accessible
names. Manual review validates optical weight and hierarchy.

## Track B: QR-first Feishu, Lark, and WeCom onboarding

### B1. Shared connector boundary

Channel implementations live in `integration_adapters`, not Core:

```ts
interface ChannelConnectorV1 {
  beginPairing(input: BeginPairingInput): Promise<PairingSession>;
  getPairingStatus(pairingId: string): Promise<PairingStatus>;
  completeInstallation(pairingId: string): Promise<ChannelInstallation>;
  start(installationId: string): Promise<ChannelHealth>;
  stop(installationId: string): Promise<ChannelHealth>;
  revoke(installationId: string): Promise<void>;
  health(installationId: string): Promise<ChannelHealth>;
}
```

Implementations are `FeishuConnectorV1`, `LarkConnectorV1`, and
`WeComConnectorV1`. Desktop, CLI, and server share the same installation,
credential vault, identity binding, connection lock, message deduplication, and
audit stream.

### B2. Pairing state machine

```text
created -> waiting_scan -> user_authorized -> waiting_admin
        -> installing -> verifying -> connected
        -> expired | denied | failed | revoked
```

The QR code contains only a short-lived, single-use opaque nonce. It expires in
five minutes, is bound to the local installation public key, and becomes
invalid immediately after successful exchange. Polling uses server-directed
backoff and stops when its registered task is disposed.

### B3. Product flows

The default path is an Otto-managed marketplace bot: scan, select organization,
approve scopes, install, verify, and send a test message. Enterprise-owned apps
remain an advanced fallback when platform policy requires an administrator to
create or approve an internal app. Secret fields are never the primary screen.

The connection page shows requested scopes, tenant, installer, bot identity,
gateway state, last successful receive/send, reconnect count, and revocation.
New scopes require a fresh approval and cannot silently inherit installation
consent.

### B4. CLI parity

`otto lark` and `otto wecom` expose `login`, `status`, `send`, `stop`, and
`logout`. CLI commands call the same local supervisor API as Desktop. They do
not create a second gateway or maintain separate credential files.

## Track C: resident supervisor and durable scheduling

### C1. Process ownership

Electron renderer owns presentation only. A resident supervisor owns:

- single-instance lifecycle and process leases;
- registered recurring tasks;
- durable workflow workers;
- channel gateways;
- RPA workers;
- power, sleep, wake, network, thermal, memory, and disk-pressure signals;
- application-update checkpoints;
- task resource budgets and termination.

The supervisor may run after the window closes only after explicit user choice.
It exposes a local authenticated IPC API and a concise menu-bar status.

### C2. Unified task definition

```ts
interface ResidentTaskDefinitionV1 {
  taskId: string;
  source: string;
  definitionVersion: number;
  schedule: OneShotSchedule | CronSchedule | EventSchedule;
  inputVersion: string;
  capabilities: string[];
  estimatedCost: CostEstimate;
  constraints: ResourceConstraints;
  missedRunPolicy: 'skip' | 'run-once' | 'ask';
}
```

Every run stores definition version, stable run id, input version, next wake,
lease, attempts, cost, origin, artifacts, and stop reason. Identical successful
input versions are skipped. Overlap is forbidden unless explicitly declared.

Timers are implementation details of one scheduler loop. Feature code cannot
create production `setInterval` calls. Sleep and wake recompute due work from
persisted time rather than replaying every missed interval.

### C3. Resource and cost governor

The governor enforces per-task and global limits for CPU time, memory, process
count, model tokens, screenshots, network bytes, artifact size, and concurrent
workers. Battery mode pauses non-essential RPA and model work. Disk pressure
stops artifact creation before the disk becomes full. Personal idle mode blocks
all paid providers and external writes.

Every external request records origin, tenant, task/run/step, provider, token
usage, retries, estimated cost, redacted destination, and result. Users can
group costs by task, channel, module, provider, and day.

## Track D: durable workflows and long tasks

`packages/workflow` becomes the authoritative state machine for supported long
work. `BackgroundTaskManager` is migrated into this model instead of becoming a
second durable engine.

Each step is persisted before execution and uses revision-checked claims.
Supported transitions are:

```text
queued -> running -> succeeded | failed | cancelled
                 -> waiting_approval | paused | unknown_outcome
```

Workflows support checkpoints, resumable artifacts, model-context compression,
human takeover, cancellation propagation, and upgrade-safe definition
snapshots. Conversation history may reference a run but is not its source of
truth.

## Track E: controlled browser and desktop RPA

Browser RPA retains its versioned semantic actions. Desktop RPA adds a separate
`DesktopRpaDriverV1` with allowlisted actions: inspect accessibility tree,
locate by role/name, click, fill, select, scroll, wait, screenshot, and
checkpoint.

Raw coordinates, arbitrary scripts, shell, credential fields, payments,
message sending, uploads, deletion, publication, and permission grants are not
ordinary RPA primitives. They require distinct capabilities and policy gates.

Every side-effecting step records approval, precondition evidence,
idempotency key, postcondition evidence, and reconciliation information.
Screenshots and accessibility snapshots are redacted and subject to quotas and
retention limits. Unchanged screens use event waits and exponential backoff,
not high-frequency capture.

## Track F: remote task control from chat

Incoming channel messages pass through:

```text
signature verification -> tenant/user/device binding -> authorization
-> intent and command preview -> policy/cost/approval
-> durable run creation -> milestone updates -> final receipt
```

Natural language may propose a task but never bypass capability checks. Chat
commands expose status, list, pause, resume, cancel, approve, deny, and take
over. High-risk actions use signed interactive confirmations with expiry and
bind the decision to a run, step, target, payload hash, and approver.

Desktop and chat refer to the same run. Offline messages have expiry and dedup
keys. Stale high-risk requests do not execute after reconnect. Progress updates
are rate-limited to meaningful milestones.

## Delivery sequence

### Stage 0: baseline and contracts

- Land this plan and requirement-to-evidence checklist.
- Inventory icons, timers, background workers, external calls, channel stores,
  workflow engines, and RPA entry points.
- Record current CPU/memory/idle-call baseline.

### Stage 1: visual convergence

- Introduce `OttoIcon` registry and migrate right-side module icons.
- Remove emoji, raster module icons, fixed accents, and raw SVG drift.
- Add theme, accessibility, and screenshot gates.

### Stage 2: channel pairing foundation

- Implement connector and pairing contracts with an encrypted in-memory test
  connector.
- Add pairing REST/IPC protocol, QR view, expiry, cancellation, and audit.
- Migrate existing Feishu credential flow behind the connector boundary.

### Stage 3: real channel onboarding

- Deliver managed Feishu/Lark installation and advanced own-app fallback.
- Deliver WeCom feasibility adapter and the strongest platform-supported
  installation flow.
- Add shared CLI commands and single-gateway enforcement.

### Stage 4: resident execution

- Add supervisor, durable scheduler store, leases, input-version skipping,
  resource governor, and window-close policy integration.
- Migrate every production recurring worker and shrink the legacy timer list to
  zero.

### Stage 5: durable long work and RPA

- Unify background agents with workflow runs.
- Add desktop semantic RPA, recovery receipts, quotas, and human takeover.
- Add sleep, restart, upgrade, offline, and unknown-outcome recovery.

### Stage 6: remote control

- Add authenticated chat commands and natural-language task proposals.
- Add interactive approvals, milestone updates, device routing, and revocation.

## Release evidence

No release is complete without:

- `npm run doctor` and `git diff --check`;
- focused Core, Server, Desktop, Workflow, and RPA tests;
- typecheck, lint, production build, and package-size gate;
- light/dark/high-contrast screenshot artifacts;
- 24-hour and 72-hour idle simulations with zero paid calls;
- offline, 429, 5xx, timeout, crash, sleep/wake, key loss, disk-full, update,
  and reconnect tests;
- duplicate message, stale message, revoked user, revoked tenant, and incorrect
  device tests;
- external-write idempotency, reconciliation, and `unknown_outcome` tests;
- a real Feishu/Lark and WeCom installation smoke test in isolated tenants;
- a real macOS accessibility-driven RPA smoke test in an isolated account.

## Completion checklist

Each explicit item in this document must map to a source file, automated test,
runtime artifact, or manual smoke record. Missing or indirect evidence means
the item remains incomplete. A green narrow unit test does not prove the full
resident, channel, visual, or RPA requirement.

## Implementation evidence snapshot (2026-08-30)

This table is intentionally stricter than a feature checklist. “Automated”
means the named source and focused test prove the behavior. “Pending smoke”
means no source-level substitute is accepted.

| Requirement | Evidence | State |
| --- | --- | --- |
| Tracked right-rail assets are classified and compact surfaces reject unregistered SVG/raster drift | `visual-asset-inventory.mjs`, inventory contract test, `visual-style-contract.test.mjs` | Automated |
| Shared theme-aware module, customer-module, navigation and channel-status icons | `ModuleIcon.tsx`, `icons.tsx`, catalog and focused component tests | Automated |
| Renderer theme source is resolved onto the document root, reacts immediately to settings and OS changes, and rejects stale startup reads | `themeSync.ts`, `themeSync.test.ts`, `visual-style-contract.test.mjs` | Automated; full screenshot matrix pending while macOS is locked |
| Production feature code has no raw interval; process watchdogs are named, observable, cost-free and stoppable | `nonOverlappingPoll.ts`, `processWatchdog.ts`, focused page/watchdog tests, production source scan | Automated |
| Shared QR connector and device-bound installation | `channelConnector.ts`, `managedChannelConnector.ts`, focused connector tests | Automated |
| Pairing QR survives nonce-redacted polling; transient status failures recover without overlapping requests | `ChannelPairingCard.tsx`, focused fake-timer UI tests | Automated |
| Desktop and `otto feishu|lark|wecom login` render scannable QR codes without printing the nonce-bearing URL; broker-directed polling is bounded to 1-30 seconds | `ChannelPairingCard.tsx`, `channelCli.ts`, `httpChannelPairingBroker.ts`, focused tests | Automated; real provider smoke pending |
| Abandoned provider credentials and device proof keys are erased at the five-minute deadline without an idle network call | `managedChannelConnector.ts`, `channel-pairing-key-store.ts`, focused expiry tests | Automated |
| Protected credential custody and idempotent outbound writes | `channelCredentialVault.ts`, `channelOutboundLedger.ts`, focused persistence tests | Automated |
| Provider 429, 5xx, timeout and interrupted prepared writes become persisted `unknown_outcome` and cannot auto-replay | `channelOutboundLedger.ts`, `managedChannelConnector.ts`, `brokerChannelRuntime.test.ts`, focused recovery tests | Automated |
| Channel revoke is fail-closed locally and uses a stable provider idempotency key | `managedChannelConnector.ts`, `brokerChannelRuntime.ts`, Server and Desktop focused revoke tests | Automated; provider-side completion may remain unknown |
| Broker outbound runtime, tenant checking, timeout and reconnect | `brokerChannelRuntime.ts`, `brokerChannelRuntime.test.ts` | Automated |
| Explicit provider-to-Otto identity binding and revocation | `channelIdentityRegistry.ts`, Server REST, CLI and Desktop tests | Automated |
| Chat command authorization, deduplication and visible reply before ACK | `channelTaskControl.ts`, `brokerChannelTaskBridge.ts`, focused tests | Automated |
| Natural-language request becomes durable approval-gated work | `workflowTaskControlPort.ts`, `durableWorkflowChannelBackend.test.ts` | Automated |
| Remote workflow visibility, mutation and approval are bound to the persisted provider, installation, tenant, canonical user and locally trusted device origin; local, cross-identity and wrong-device workflows fail closed | `brokerChannelRuntime.ts`, `workflowTaskControlPort.ts`, focused tests | Automated |
| Chat-created external-workflow approvals persist a ten-minute deadline and a request/origin payload hash; expired or changed payloads cannot execute | `workflowTaskControlPort.ts`, focused tests | Automated |
| Durable workflow state changes produce restart-safe, idempotent chat milestones; first adoption creates a silent baseline instead of replaying history, unchanged states and timestamp churn do not notify, tracking is capped at the 10,000 most recently updated owned runs, and the worker is a named zero-cost recurring task | `channelWorkflowMilestones.ts`, `managedChannelPlatform.ts`, `server.ts`, focused tests | Automated |
| Non-overlapping workflow worker skips unchanged persisted revisions | `recurringTaskRegistry.ts`, `server.residentTasks.test.ts` | Automated |
| Workflow traces serialize concurrent appends, retain a valid rolling 5 MiB JSONL tail per run, cap trace files at 10,000, and only prune files older than 30 days | `workflow/src/trace.ts`, focused trace tests | Automated |
| Workflow run files are capped at 10,000; creation is serialized, expired or oldest terminal runs are pruned first, while active, paused, approval-waiting and unknown-outcome runs are never automatically removed | `file-workflow-store.ts`, focused capacity tests | Automated |
| ACP delegate session handle is persisted before work; every background turn links to a durable external Workflow step; restart becomes `interrupted`/`unknown_outcome`, never silent replay | `externalTaskWorkflowJournal.ts`, `acpAgentClient.ts`, `backgroundTaskManager.ts`, delegate status and restart tests | Automated; BackgroundTaskManager remains a compatibility UI mirror |
| The compatibility task mirror uses collision-resistant IDs, caps records at 1,000, preserves running tasks under pressure, bounds stdout/stderr/final answers/plan snapshots, removes direct result mutation, and rejects unsafe persisted filenames/symlinks | `backgroundTaskManager.ts`, `delegate-agent.ts`, focused compatibility tests | Automated |
| Starting a local external coding agent requires explicit approval and declares its affected working directory | `delegate-agent.ts`, focused confirmation tests | Automated |
| Background delegate owns a registered stop function; parent-turn cancellation cannot kill it, while explicit cancellation and clear-all stop the ACP turn exactly once | `backgroundTaskManager.ts`, `delegate-agent.ts`, focused lifecycle tests | Automated |
| Active Ctrl+B/auto-background shell path registers a process-group stop function, persists a durable external Workflow step, and uses truthful success/failure/cancelled terminal states | `shell.ts`, `externalTaskWorkflowJournal.ts`, `backgroundTaskManager.ts`, focused journal/shell tests | Automated |
| Durable RPA supports persisted pause/resume/cancel, propagates abort signals, and converts interrupted external actions to non-replayable `unknown_outcome` | `rpa/src/runner.ts`, `core/src/tools/rpa-run.ts`, focused runner/tool tests | Automated |
| RPA resource bounds limit workflows to 100 steps, step output to 64 KiB, artifacts to 10 per step and 10 MiB each with atomic writes | `runner.ts`, `file-artifact-store.ts`, focused overflow tests | Automated |
| RPA evidence storage is globally bounded to 512 MiB and 10,000 files with incrementally cached accounting; concurrent writes are serialized, and quota/disk failure retains earlier evidence references on the visible failed receipt instead of deleting or orphaning them | `file-artifact-store.ts`, `runner.ts`, focused quota tests | Automated |
| Real managed Feishu/Lark installation and message round trip | Isolated provider tenant and production Broker | Pending smoke |
| Real managed WeCom installation and message round trip | Isolated provider tenant and production Broker | Pending smoke |
| macOS Accessibility RPA control and recovery | Signed local build and isolated macOS account | Pending smoke |
| 24/72 hour zero-paid-call idle proof | `idle-safety-simulation.test.ts`: real registry clock, seven intercepted external origins and eight failure classes | Automated virtual-clock proof; release-candidate wall-clock artifact pending |

### Cleanup decisions

- Removed the public `ChannelConnectorV1.approveAdmin()` method. Provider admin
  approval is accepted only as a Broker state transition; a local REST, CLI or
  Desktop caller cannot manufacture it.
- Removed the residual `/channels/pairings/:id/approve` route match entirely.
  Terminal pairing routes now release their provider index, so completed,
  denied and expired sessions cannot accumulate during long-running service.
- The legacy self-hosted Feishu credential path remains only as an explicitly
  labelled advanced compatibility path. It must not be reused by managed QR
  connectors or treated as the default onboarding design.
- Generated `dist`, release packages and test reports are evidence artifacts,
  not source inputs, and must remain outside committed source payloads.
- Uploaded and generated artwork remains available in explicit editor/gallery
  contexts, but no longer controls compact Workspace tiles. Custom experts and
  customer modules use registered semantic icons there so theme and optical
  weight cannot drift with package content.
- Removed private inline close, delete and overflow SVGs from App, Sidebar and
  conversation overlays. New common navigation/overlay icons must enter through
  the shared registry; functional QR SVG remains separately classified.
- Replaced renderer feature `setInterval` calls with either non-overlapping
  async polling or deadline-based one-shot timers. Core protocol watchdogs and
  Server generated admin pages now use named process watchdogs or non-overlap
  one-shot deadlines. MCP temporary-file expiry is reclaimed on real use and no
  longer wakes an otherwise idle process every five minutes.
- Removed the legacy Core `MultiChannelGateway` and `multi_channel` tool. They
  formed a second provider-specific gateway, wrote provider secrets outside the
  credential vault, and let meeting reminders bypass durable workflow,
  idempotency, and channel identity policy. `meeting_actions` now exposes a
  local `list_due` operation; external delivery must use the managed channel
  workflow and its explicit approval path.
- Channel revocation now removes the local credential and runtime state even
  when the provider DELETE times out, so a revoked installation cannot silently
  reconnect after restart. The DELETE carries a stable idempotency key and the
  Desktop removes the local installation while showing that the remote outcome
  is unknown; this does not claim that provider-side revocation completed.
- Removed duplicate self-fallbacks for `OTTO_DELEGATE_TASKS_DIR` and
  `OTTO_CC_TIMEOUT_MINUTES`; they could never select a distinct legacy value
  and obscured the active configuration contract. ACP delegate sessions now
  persist their native resume handle immediately. A daemon restart records an
  explicit `interrupted` state and never automatically resubmits the prompt;
  full migration from `BackgroundTaskManager` to Workflow remains pending.
- `delegate_to_agent` now exposes the target working directory and requires an
  explicit outer confirmation before its internally auto-approved ACP session
  can read, modify or execute within that project. This closes the previous
  path where a model or remote channel could start a writing agent silently.
- Background ACP delegate turns now create and claim an approved external
  Workflow step before the agent process starts. The compatibility task record
  stores `workflowRunId`; success, failure and cancellation settle that run.
  Restart recovery converts a still-running external step to
  `unknown_outcome`, while the saved ACP session handle remains available for
  an explicit resume. If the Workflow journal cannot be written, the agent is
  not launched. `BackgroundTaskManager` is still retained for existing UI and
  notification consumers and is not claimed as fully removed yet.
- Background delegate execution no longer borrows the parent tool call's abort
  signal. Each task registers its own stop function; explicit cancellation and
  clear-all invoke it exactly once, while late output or completion cannot
  overwrite a cancelled terminal state. This is the process-local stop half of
  the window-close policy; the Desktop choice UI still remains separate.
- Removed the unreferenced `ShellTool.executeBackground()` implementation and
  the PID-only `BackgroundTaskManager.killTask()` branch. They duplicated the
  live Ctrl+B/auto-background spawn path and terminated a different process
  scope on Unix. The live path now registers its existing process-group abort
  function and uses the shared `cancelled` transition.
- Generalized and renamed the delegate-only journal to
  `externalTaskWorkflowJournal`. The active shell background path now waits
  until its Workflow record is persisted before reporting success, persists
  its compatibility record after linkage, and settles nonzero exits as
  `failed` instead of the previous false `completed`. A journal write failure
  stops the spawned process and is returned visibly.
- RPA `paused` and `cancelled` are now real persisted transitions exposed by
  Core, including pause/cancel requests made while a step is active. An
  already-aborted run does not claim a step; abort after an external action is
  claimed records `unknown_outcome` and cannot replay. Workflow size, output,
  artifact count and artifact bytes are bounded, and artifact files use an
  atomic temporary-file switch with failed temporary writes removed.
- Desktop no longer relies solely on Chromium media-query repaint timing when
  Electron changes `nativeTheme.themeSource`. The renderer records both the
  requested and resolved theme on the document root, updates immediately from
  Settings, follows OS changes only in system mode, and ignores a stale startup
  read after a newer user choice. Explicit light/dark token overrides cover the
  right rail and detached subpages. The real screenshot matrix remains pending
  until the local Mac is unlocked; automated contracts are not presented as a
  substitute for that review.
- ESLint now ignores all Desktop preview bundle directories (`preview-dist`,
  `setup-preview-dist`, and `live-dist`). These generated bundles are already
  Git-ignored and must not be parsed as source or create false release blockers.
- The shared channel CLI now emits an actual compact terminal QR for Feishu,
  Lark, and WeCom instead of printing the nonce-bearing pairing URL. Desktop
  and CLI consume the same server-directed polling delay; the HTTP Broker
  adapter clamps it to 1-30 seconds so a provider cannot cause a hot loop or
  suppress status indefinitely. `qrcode-terminal` is now declared by the
  Server package that imports it, and the stale missing `otto` bin entry in the
  lockfile was repaired.
