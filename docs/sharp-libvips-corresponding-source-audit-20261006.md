# sharp/libvips native inputs — 1.9.21, 2026-10-06

This updates the engineering inventory in the retained
`sharp-libvips-corresponding-source-audit-20260909.md`. It is not a legal
certification, a complete native build-closure attestation, or proof of executing
a rebuilt/modified library. The historical document describes the older binaries,
not the current release. Its rebuild/relinking procedure and limits still apply.

## Measured current components

The release pins sharp 0.35.5 and sharp-libvips 1.3.4. Independently downloaded
and SHA512-verified `versions.json` files from all five shipped targets
(Windows x64, macOS x64/arm64, Linux x64/arm64) report libvips 8.18.7,
librsvg 2.63.2, glib 2.90.0, fribidi 1.0.17, cairo 1.18.6, libheif 1.23.5,
libexif 0.6.26, pango 1.58.2 and proxy-libintl 0.5. These inventories are
recorded separately in `scripts/heic-corresponding-source-inputs.json`; they
are never copied from another platform's execution results.

The Linux/macOS libvips packages declare LGPL-3.0-or-later; the Windows sharp
package declares Apache-2.0 AND LGPL-3.0-or-later. The current upstream notices
elect LGPLv3 through the indicated later-version clauses, and **MPL-1.1 for
cairo** (different from the historical upstream table). The shipped NOTICE
retains the current table and exact Cairo `COPYING-MPL-1.1` text extracted
from the verified 1.18.6 archive. That text is also a byte-verified tracked
sidecar input, with its parent URL and archive member recorded. Original
copyrights and Cairo's alternative LGPL terms remain in its source archive.
No license or copyright text is invented. The previously supplied MPL2 text
is retained as historical material, not asserted as the current elected license.

## Fixed input identities

- sharp source: `51a990faa26ade5586a4934ac9673c98d8893326` plus the exact
  locked npm tarball containing its generated JavaScript and C++ sources.
- sharp-libvips build recipes/notices: `ebb95f8add54eee8bed840e3fb587e4cbec857d7`.
- libvips source: official 8.18.7 release tar, source tag commit
  `24ad4d042940e6bf99a68871ba886ca8847c9c82`.
- Windows recipes/patches: `ef19ca09af2453d127453d677c849ccb37cf5694` and
  the official 8.18.7 static development ZIP; npm development/relinking
  packages are independently verified at 1.3.4.
- The Windows recipe references mutable MXE branch `llvm-mingw-20260924`.
  Observed snapshot `c36160b231e66e1cbe032ed54aef7617e8b259da` is retained,
  **not attested as the original binary build commit**. Its default OCI image
  remains mutable; the original build image digest is not established.
- Updated glib, fribidi, cairo and librsvg release sources accompany the
  binaries. Native libheif 1.23.5 is supplied separately: the unchanged HEIC
  WASM path still uses 1.23.2, with different flags and source provenance.
- The upstream POSIX recipe applies librsvg embedded-image memory-limit
  patch `9106011db93d701728ac2c9da50c9ab2c1bb5dc6`; its exact official patch
  is retained, alongside the original recipe and release Cargo.lock.

Every archive has measured length/SHA256 and, where applicable, npm SHA512.
Public source files were read without executing their build scripts. The source
manifest and frozen release lock are validated together before assembling a
sidecar from clean, immutable Git blobs. The standalone licenses, NOTICE,
build sources and exact Otto source are included in the same release-bound
corresponding-source archive, not installer source-size budgets.

## Limits and release status

The recipe's `cargo update --workspace` and mutable build-image/MXE inputs mean
the exact final Rust crate closure and original binary build provenance are not
established. No upstream source rebuild, modified-library replacement, or
bitwise reproducibility is claimed. This does not itself prove all permissive
notice, combined LGPL/relinking, or distribution-specific obligations.

The manifest update alone is not installed-package acceptance. The final 1.9.21
artifacts still require package-native probes, current source-sidecar checks,
license/security scans, installation/upgrade acceptance and release receipts.
Do not infer a successful formal release from this engineering inventory.
