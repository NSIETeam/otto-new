# Verified seven-feature rollback checkpoint (1.9.14)

This is an independent, **unsigned** recovery checkpoint, not a replacement for
the original public 1.9.14 release and not a claim that a historical mutable
production directory was an intact original package. Never edit that directory
or its original manifest. No production access, signing key or network is used.

## Exact source and artifact scope

The parent is `fa3f98a1fdc0bddc6aa48a6ecf1bd13bd8300f69`. Only seven server
TypeScript files and their three tests are replayed from the already-audited
`086d1f17447da13c9c018734ca5b2b05f49fd0a0` organization fix and
`8dbd341cb53adc0659708c9dc1b53ce0359e71ed` deployment-wide seven-feature fix.
The script pins every source Git blob and every compiled output SHA-256. It
rejects any additional source delta except these five recovery recipe files.
Desktop cache changes and the historical deployment `verify.sh` change are not
included. All 2,115 original tree files are materialized. Missing local Git
objects were recovered from existing source archives/checkouts only after their
Git blob hashes matched the original fa3f tree; no network fetch was performed.

The original signed archive SHA-256 is
`7425361092e933b8194c628f43b6bf677b4b36a6e0a16d42045cc15ca4c74f55`;
the original manifest SHA-256 is
`9dbae2ea3e8f4dcb11f93bb36a579d0f4ab5f18f7af3a2fcd93ade1b66fc3389`.
The original Ed25519 envelope is verified with public key ID
`74def647c0970a16` before extraction. The copied public PEM is public material
only; its key bytes match the administrator-provided archived public key.
All 7,654 original runtime files are checked before overlays are applied.

Six outputs use TypeScript 5.9.3 `transpileModule` with ES2022 module/target,
source maps enabled and source basename as filename. Organization feature access
uses esbuild 0.25.12 with TypeScript loader, ESM format and Node 22 target.
All seven outputs must reproduce the exact observed historical hashes.
`authorizationComposition.js` is a deliberate byte-identical copy of the base.
The old deployment tar's `SHA256SUMS` is not copied. Unchanged source maps remain
the original signed bytes; this procedure does not claim a full fresh rebuild.

All original source inputs are checked: unchanged tracked source must match the
original signed inventory; replayed source must match the pinned Git objects;
the nine native inputs must match the original archive and retain **fa3f native
build provenance**. The new portable-path source fingerprint covers those
inputs, the two newly introduced source/test files, all five recipe files, and
three named immutable external inputs. It does not relabel native binaries.

## Local build and review

1. Review the ten replayed files and this recipe, run
   `node --test recovery/checkpoint.test.mjs`, and create one clean commit directly
   on the stated parent. The source commit represents this composite recipe.
2. Run `node recovery/reconstruct-checkpoint.mjs build` in the fixed isolated
   checkout `D:/otto/otto-rollback-baseline-1.9.14`. The original archive is read
   from `D:/otto/artifacts/v1.9.14-enterprise-fa3f`; compiler packages are read
   from the candidate's existing dependency tree without installation.
3. Inspect the new directory under
   `D:/otto/artifacts/rollback-baseline-1.9.14-verified-seven`. Its name is
   `1.9.14-<actual-content-SHA1-prefix>`, not a historical hotfix directory name.
   Original manifest/source inventory/envelope, the recipe and the reconstruction
   record are included in the **new** file hash set. Source and native provenance
   remain explicit. The new source commit and source-input SHA are not borrowed
   from either historical release.
4. The unchanged current strict verifier snapshot is run with **no legacy or
   hotfix flags**. Full-tree metadata-byte tampering and dirty-source-manifest
   negative checks must both reject. The tree is fully reverified afterward.

## Administrator-only next step (not performed by this recipe)

Review the new commit, full receipt, inventory and reconstruction record. Sign a
new immutable checkpoint envelope/acceptance record using the normal authorized
process; do not publish or overwrite the old GitHub 1.9.14 release. Bind the new
manifest SHA-256, actual content identity, source fingerprint, archive/signature
provenance and a redacted runtime-environment receipt. Preserve the existing
enterprise identity, keys and data, including deployment grants:
`enterprise_tree,park_service,feishu_auto_reply,direct_messages,atoa,knowledge,skill_market`.
The activation environment must use the **new** manifest build identity, not
`8dbd...`, with a separately prepared reversible environment change.

Stage the new canonical directory beside the unchanged original. Strictly verify
it with the production gate; perform the approved isolated health/schema/feature
canary before making it an accepted rollback target. This local artifact check
does not claim a Linux runtime or production canary has already passed. Never
weaken the new-package gate or rewrite historical metadata to accept drift.
