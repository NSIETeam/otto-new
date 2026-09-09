# Disposable canary handshake diagnostic

This branch is diagnostic only, based on `0dbbe7a8d165ac42770dda516fde8f0170ce9cfd`.
Do not merge it into the release branch or treat a green diagnostic as production
acceptance. Original failed formal run `34344298699` remains failed and retained.

The existing fixture harness selects only its original `success` and `drain45`
positive cases; their business-independent systemd/isolation/cleanup assertions
are unchanged. Three separate disposable GitHub-hosted Ubuntu jobs run:

1. `original`: byte-identical production controller/worker in the fixture package.
2. `observed`: only the temporary package copy receives phase assignments and a
   final-catch observer. It writes fixed phase/errno/error-name/error-code enums to
   the existing writable work directory. Original error handling/exit5 remains.
3. `inject-go`: same observer, plus an explicitly marked 500ms controller pause
   between creating root-only `go.json` and chmod0444. Runs `success` only. This
   diagnostic expects a real worker exit5 with `go-read/EACCES`, and clean cgroup
   cleanup. Its original harness receipt must remain failed; only the separate
   diagnostic expectation may pass.

All four source files are SHA256-pinned to the failing formal source. Source
files in the checkout are never changed; package-copy hashes are recorded. The
observer can affect scheduling, so an observed-mode pass cannot disprove the
original race. An injected failure demonstrates a feasible path, not proof that
it caused the earlier formal failure. The `ready-read` phase also distinguishes
readiness JSON parsing failures without logging file content.

No repository/environment secrets, npm dependencies, SSH, deployment calls,
production directories or production data are used. Runtime/harness execution
uses a private network namespace and the original worker's separate systemd
PrivateNetwork, UID, cgroup, resource limits and read-only mounts. Public Node
setup/checkout/artifact upload occur outside that namespace, as in the existing
fixture workflow. The output does not contain raw worker stderr, stack, message,
credentials, configuration or DB files. Only `receipt.json` and `diagnostic.json`
are uploaded; never the work tree. Fixed source hash, diagnostic commit, injected
mode, exit result, milestones, and cleanup proof distinguish each observation.

Local validation: `python -I -B scripts/tests/canary-handshake-diagnostic.py
--self-test` verifies pins, exact injection anchors, untouched original bytes,
fixed capture enums and unsafe-field rejection. These are facility checks, not
Linux/systemd execution. Linux root/hosted/network/cgroup/production-path checks
must pass before the existing harness starts units. Preserve all failed outputs;
do not rerun until the evidence is understood.
