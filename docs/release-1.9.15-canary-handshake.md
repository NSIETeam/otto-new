# 1.9.15 canary publication and shutdown regression

The failed release preflight (Actions run `34344298699`) stopped before builds,
publication, or deployment. Its short worker exit did not retain an errno, so
the exact cause of that historical exit remains unproven. In a separate
disposable Linux runner (`34346138175`), explicitly delaying the original
`go.json` permission update reproduced `EACCES` before migration began. Original
and observation-only control cases also ran successfully; neither is evidence
that an intermittent race cannot occur.

## Production changes

- The controller prepares the entire nonce payload and its final readable
  permissions in a private exclusive file, syncs it, and exclusively links the
  final name. Existing files and symlinks are never overwritten.
- Runtime readiness uses the same complete-before-visible, exclusive publication
  pattern. The worker waits for the producer's temporary second hard link to be
  removed within the existing health deadline. Final receipt validation still
  requires exactly one link, correct ownership, and safe permissions.
- The worker no longer forwards an extra SIGTERM. The existing systemd
  `KillMode=control-group` already signals the runtime and its descendants.
- Runtime SIGTERM/SIGINT listeners remain installed while draining. Its existing
  idempotent shutdown, database protection, and force-stop deadline remain.

There are no changes to deployment privileges, host reboot behavior, resource
limits, acceptance standards, or rollback gateway commands.

## Verification and scope

Focused tests execute the actual runtime entry point with disposable adapters
and inject publication faults. They check complete bytes before visibility,
exclusive publication, cleanup ownership, signal handling, and database-close
behavior. Windows-specific directory-sync/signal substitutes are labeled; they
do not count as POSIX evidence.

The real systemd acceptance runs only on disposable hosted Linux runners, with
network namespaces and no deployment credentials. It retains success, 45-second
drain, migration failure, runtime failure, OOM, residual-process, and hung-stop
cases, and adds temporary/persistent double-link readiness cases. Migration and
HTTP business adapters are synthetic: this acceptance proves controller and
process isolation, not a production SQLCipher migration or enterprise workflow.

All failed and successful runs remain separate. A new candidate must pass its
own CI and the formal release preflight; no historical green run substitutes for
that requirement. Actual production migration and update-channel verification
remain separate release gates.
