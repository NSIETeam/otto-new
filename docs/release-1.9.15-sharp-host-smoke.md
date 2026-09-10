# 1.9.15: isolate native dependencies for cross-host startup checks

Formal release run `34493462263`, source
`aac98c1b7aab1c4de9b6adf7d143eda10b483d0f`, passed quality gates and desktop
packaging, then failed the enterprise startup probe on macOS ARM. The enterprise
payload deliberately includes only Linux x64/ARM64 Sharp and libvips packages;
importing that payload on the build host required the host's native Sharp addon.
No production deployment or publication occurred in that failed run.

The builder now materializes only the explicitly reviewed host Sharp optional
packages in its fresh OS-temporary ancestor. Downloads retain the existing exact
npm URL, locked version, whole-archive SRI, bounded extraction, path checks and
second byte-for-byte verification. Node's normal `createRequire` resolution can
use those sibling addon/libvips packages during both startup probes. No arbitrary
host `node_modules`, host database binding, NODE_PATH override or import stub is
used. Existing ancestor dependencies cause failure rather than being overwritten.

The release directories, Linux provenance, content fingerprint and final archive
do not include this ancestor. Native Linux builders add no bridge and perform no
host download. Both staging and extracted-archive bind/close/state-write probes
remain required and their failures still stop packaging. On a non-Linux host they
prove JavaScript closure/startup with a host-native media bridge, not native Linux
or SQLCipher execution. The Linux installation canary remains required.

Verification of the change:

- Before implementation, eight new regressions failed and 27 existing cases
  passed. After implementation, 53 related packaging tests passed with one
  existing local-platform dependency-copy skip.
- Real Node resolution checks cover both staging and extracted-archive directory
  layouts, all three supported desktop hosts, Linux no-bridge behavior, unchanged
  target provenance, corruption rejection and refusal to overwrite dependencies.
  Removing each host package is checked in a fresh process to avoid module caches.
- Workflow/Core/Server rebuilds, focused lint, doctor, code-map and diff checks
  passed. A separate local preflight copies the complete locked 144-package
  production dependency graph without workspace junctions, processes an image
  with real Sharp, and runs the real product startup probe. Its extracted-tar and
  byte-identity results are retained in release diagnostics, not inferred from
  these unit tests.

The local preflight initially used a directory under an existing developer
`node_modules` ancestor and correctly rejected that resolution. It was moved to
the same fresh OS-temporary boundary as the actual builder. That was a test
fixture problem, not a reason to change product dependency selection.

This change does not alter dependency locks, business code, signing policy,
installation safety, installer size budgets or release/deployment permissions.
Passing local checks is not a successful signed package, Windows upgrade or
production release; the new formal run must supply those separate results.
