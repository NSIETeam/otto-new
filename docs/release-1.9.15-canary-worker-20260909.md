# Signed-package upgrade canary isolation

The upgrade path now uses the package's `tools/canary-worker.mjs`. It is not the
checkpoint diagnostic helper and is packaged/hashed with every future release.
The unchanged release signature/provenance gate runs before this controller.
No production deployment or reboot was performed to develop this change.

## Interface and custody

`launch --transaction <absolute root:root 0700 transaction>` prepares the
already-snapshotted `canary/work`, a read-only package copy and root-only control
records. `stop --transaction ...` proves termination independently of worker
receipts. `verify-deliverable --transaction ...` repeats that proof and binds the
DB/resident output hashes immediately before the existing cutover installs them.
The hidden `_worker` entry refuses root/direct execution outside its nonce unit.
There is no arbitrary command, unit-property or resource-budget argument.

The dedicated non-login `otto-upgrade-canary` UID/GID cannot be the production
identity, share other users/groups or have an existing process. Upgrade and
dry-run share the deployment lock. Only the worker subtree changes ownership;
TXN parents, rollback DB/config/deploy snapshots and controller receipts remain
root-only. Fixed bind mounts allow the worker to read its own view without
opening the transaction parent. The candidate package is copied read-only;
runtime native libraries remain available from the host's read-only system tree.

Only the SQLCipher key, existing business-key copies, deployment License grants
and a new random canary-only admin token enter the runtime. Production SMS,
Feishu, proxy and bootstrap/admin credentials are not forwarded. `LoadCredential`
supplies private controller config/key material without secrets in argv, unit
Environment properties or journal output. The original SMS configuration is
validated through the shared health function against the root-only config
snapshot; its digest is bound to the result. Final production verification still
uses the original SMS requirement. No placeholder SMS values are used.

## Enforced execution and delivery gates

The transient service has total `MemoryMax=500M`, no swap, CPU quota 50%, 64 tasks,
180 seconds running and 60 seconds stopping. The controller has five additional
seconds of control allowance (245 seconds from dispatch); health readiness and
all three endpoint bodies share one 30-second deadline that never resets.
The 60-second stop window preserves the existing runtime's approximately
45-second drain/checkpoint contract. Memory admission requires 700 MiB available;
disk admission requires 1 GiB free. This is not a filesystem quota.

Migration, runtime and health all execute in the same cgroup and network/mount/
IPC namespaces. Capabilities are empty, no-new-privileges and seccomp apply,
the system is read-only, and only `canary/work` is writable on host persistent
storage. `/run`, `/tmp` and `/var/tmp` are empty read-only mounts. AF_UNIX creation
is forbidden as well: PrivateNetwork alone does **not** isolate pathname Unix
sockets. The root controller reads actual unit properties, `/proc` identities,
mounts, namespaces and cgroup resource controls before releasing migration.

The health module retains the public identity/exact-field/capability/legal
contracts, authenticated build/schema/License checks and active SQLCipher
assertion. Transport refuses redirects, bounds bodies to 1 MiB and never prints
raw server bodies or secrets. Schema comes from the package manifest, while the
unchanged migration checker reconciles the existing baseline row counts.

Successful delivery requires actual `systemd-run --wait` exit 0, matching pinned
InvocationID/cgroup, clean runtime exit 0, and the entire cgroup empty (including
descendants). A successful transient unit may already be collected: `not-found`
alone is not success; the root-owned wait result and previously observed identity
are required. Unknown stop results retain recovery evidence and prohibit DB
copy, rollback restoration and restart. Failed/OOM/timed-out units cannot deliver.

## Verification and limits

Focused tests were written before the new interfaces (RED), then passed after
implementation. They cover resource/credential/mount contracts, clean-stop
negatives, changed invocation/result, redirect/large/never-ending body handling,
literal config parsing and cleanup's no-mutation behavior after unknown stop.
Existing preservation and installer health/License tests are retained; assertions
that referred to the removed inline canary now target the same worker contract.

`scripts/tests/enterprise-canary-systemd-integration.py` is restricted to disposable
GitHub-hosted Linux and uses real systemd/cgroup v2/namespace isolation. It runs
success, 45-second drain, migration/runtime exit 7, cgroup OOM, residual process
and stop-watchdog cases, plus host IPC/read/write/credential probes and output
tampering rejection. Migration and HTTP fixtures in this harness are synthetic:
passing it is **not** proof of a real SQLCipher/business migration or a live model
evaluation. Existing signed-package migration/health acceptance remains required.

Local Windows / Node 24.17.0 results: 4 focused files, 99 passed and 4 pre-existing
platform skips; ESLint (zero warnings), Prettier, Node and Bash syntax checks,
Python AST and both embedded Node fixtures' syntax, doctor, diff checks and
code-map/check passed. At authoring time, these local checks were available;
real Ubuntu systemd execution is a separate required CI result, not presumed.
No production secrets or real external sends are used in the harness. Stop-unknown
evidence is retained for operator recovery; the controller never reboots the host.
