# 1.9.15: enterprise adapter startup closure

A local preflight ran the actual enterprise builder's server, narrow core
adapter and workflow copy blocks, then its actual loopback bind/close smoke
program. This exposed two startup errors before another formal release:

- The server re-exports `WorkspacePathIdentity`, but the narrow adapter omitted
  its implementation and export.
- Private deployment bootstrap imports `otto-core/recurring-tasks`, but the
  adapter package exported only its root.

The builder now copies and exports the existing shared path-identity helper,
includes its source in both dirty-tree scope and source-input fingerprint, and
maps the recurring-task subpath to the already shipped registry implementation.
It does not replace the adapter with the full agent kernel or change business
logic, dependencies, license policy, cryptographic checks or deployment gates.

The focused regression executes the actual adapter copy/manifest block, compiles
the real shared identity and registry implementations, and uses native Node ESM
to import the server compatibility export and both registry paths. It checks
byte-identical delivery, common registry identity, replaced-directory rejection,
missing-helper failure, and both source-identity lists. Unrelated adapter exports
are stubs in this focused fixture, not business-flow evidence.

Actual local results: missing-file regression RED before the fix; subpath and
source-list regressions RED after only the first partial fix; all four adapter
tests GREEN after the complete fix. Combined related packaging tests: 18 passed,
one existing local-platform skip. The real offline server smoke subsequently
starts, closes and persists recurring-task state successfully (exit 0).

Smoke evidence is in local diagnostics `enterprise-payload-5cf3ac75-SGiusQ`.
It used base commit `5cf3ac75` plus the uncommitted builder whose SHA-256 is
`fc7572b548a5285bf54294970b5faf55e6864672519382348aa95294066d86c3`.
It reused local registry packages, disabled encryption, and did not verify an
archive, SQLCipher, a signature, Windows installation or production deployment.
An earlier diagnostic linked the root's unrelated pg 8.11.3; that fixture error
was corrected to the server's locked pg 8.22.0, not treated as a product defect.
All unsuccessful diagnostic attempts were retained separately.
