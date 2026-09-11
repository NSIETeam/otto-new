# 1.9.15 release control-plane recovery

## Observed failure

Release run `34556001807`, source
`268071eb898522dfda3122a6c89a8c2a7fff122d`, completed its desktop build,
Windows upgrade acceptance and creation of both unpublished release drafts.
The reusable deployment workflow then received empty deployment environment
values and rejected the host before any SSH operation. Visibility compensation
also stopped before mutation because GitHub's release-by-tag endpoint did not
return the unpublished draft. Production remained on 1.9.14.

## Scoped corrections

- Inherit secret context only at the same-repository, same-commit reusable
  deployment call. The called jobs retain their protected environments,
  approval dependencies and least-privilege job permissions.
- Reject missing configuration before creating private-key files or executing
  SSH. Report variable names only. Both principal checks remain identical;
  reject ports outside 1–65535 explicitly, including under Bash `set -e`.
- Resolve an exact draft tag across all release pages, then recheck its numeric
  ID and tag through the ID endpoint. Read all assets from their paginated
  endpoint instead of trusting an embedded list.
- A draft may genuinely have no Git tag yet. Preserve that absence as `null`,
  never as an invented source commit. Published releases still require an
  exact tag; existing incorrect tag commits, wrong targets, changed assets,
  authentication errors and drifting latest pointers remain failures.

## Evidence and limits

Focused tests exercise actual pre-materialization Bash validation and the
GitHub adapter's real application logic with a mocked read-only HTTP transport.
They do not prove hosted environment-secret resolution or production deployment.
The original failed logs and previous passing build/upgrade evidence are retained
under local diagnostics, not rewritten as successful publication evidence.

## Recovery sequence

1. Preserve original creation intent, release IDs, complete asset identities and
   recoverable bytes from the failed run. Require exact asset equality and both
   releases still draft, with the original latest pointers unchanged.
2. Withdraw only those exact unpublished drafts through the existing guarded
   draft-recovery transaction. Do not alter already-public releases or labels.
3. Merge this correction normally and start a fresh attempt-1 release bound to
   the new source. Do not retarget old artifacts or reuse their proof as evidence
   for a different source.
4. Observe actual deployment and capture the deployment receipt before
   finalization, then verify both public repositories and the update mirror.
   No host reboot is part of this recovery.
5. Delete temporary publishing-token copies and restore the normal approval
   setting after publication or compensation terminates.

Unsigned desktop distribution remains an explicit release exception, not a
guarantee of unattended installation under every user's OS security policy.
