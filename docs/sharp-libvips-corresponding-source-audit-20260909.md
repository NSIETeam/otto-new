# sharp / libvips source and relinking audit — 2026-09-09

This supplements, not replaces, `heic-corresponding-source.md`. The HEIC/WASM
exercise does not demonstrate native libvips replacement. This is an engineering
inventory and rebuild procedure, not a legal-compliance or reproducible-build
attestation. No native library was rebuilt or modified in this audit; no production
or signed installation was changed.

## Actual distributed components

The integrated release lock pins `sharp` 0.35.4 and the libvips binary packages
1.3.3, containing libvips 8.18.6. The Linux x64/arm64 and macOS x64/arm64
`@img/sharp-libvips-*` archives declare **LGPL-3.0-or-later**; the Windows x64
`@img/sharp-win32-x64` package combines Apache-2.0 and LGPL-3.0-or-later.
The standalone libvips source contains LGPL 2.1, with its later-version option.
Do not describe the complete prebuilt combination as Apache-only or LGPL-2.1-only.

The pinned [upstream notices](https://github.com/lovell/sharp-libvips/blob/6e5971d333377743163edc3ad9e5d0b897abcbc9/THIRD-PARTY-NOTICES.md)
identify fribidi, glib, libexif, libheif, librsvg, libvips, pango and proxy-libintl
as used under LGPLv3 via their later-version clauses, and cairo under MPL-2.0.
Preserve these notices, the GNU LGPL3/GPL3 texts already in the common sidecar,
and the original copyright/license files inside the supplied component sources.
The cairo archive retains its original MPL1.1/LGPL2.1 texts; the separate official
Mozilla MPL2.0 text accompanies the version elected by the upstream combination.
The table also names permissive components; it is not a substitute for their
copyright notices and complete license texts.

Actual archive inventory matters: the examined Linux/macOS libvips runtime
packages have no standalone LICENSE/THIRD-PARTY-NOTICES file. Windows sharp's
LICENSE is Apache text, while the separate upstream Windows dev ZIP has the
complete LGPL2.1 LICENSE. Retaining only files named LICENSE in runtime packages
would therefore lose information. The combined application NOTICE must also
identify these libraries and point to the release's common source sidecar.

| Copyleft component | Version in all five audited targets | Source material |
| --- | --- | --- |
| libvips | 8.18.6 | Official release source tar.xz, including LICENSE |
| glib | 2.89.4 | Official release tar.xz, including bundled gvdb source and license |
| pango | 1.58.2 | Official GNOME source tar.xz |
| librsvg | 2.62.91 | Official GNOME source tar.xz, original Cargo.lock and workspace source |
| fribidi | 1.0.16 | Official release source tar.xz |
| libexif | 0.6.26 | Official release source tar.xz |
| proxy-libintl | 0.5 | Official upstream tag archive, content hash pinned |
| libheif | 1.23.2 | Existing common sidecar source, native flags differ from WASM |
| cairo | 1.18.4 | Official source tar.xz, MPL source and modifications in build recipes |

The actual `versions.json` files agree on these versions. Linux/macOS report
AOM 3.15.0, Windows reports 3.14.1; the remaining reported component versions
agree. Do not assign one platform's entire build inventory to another.

## Fixed source and linking material

The additions to `scripts/heic-corresponding-source-inputs.json` are independently
hashed, official inputs, not new installed runtime dependencies. Twenty-one measured
inputs total 139,363,294 bytes; the largest is the sharp Git source archive at
41,797,945 bytes. They stay outside installer/source-size budget calculations.

| Material | Fixed identity |
| --- | --- |
| sharp v0.35.4 Git source | `7f1a0a22cc285fe180766f4935d50b55af6e8432` |
| sharp 0.35.4 npm source/package | Exact release-lock SHA512; includes C++ source, binding.gyp and generated dist missing from Git archive |
| sharp-libvips v1.3.3 build source | `6e5971d333377743163edc3ad9e5d0b897abcbc9` |
| libvips v8.18.6 source | `426af3f44246fce9cfa8dd51a353aa4dfd48c553`; official release tar SHA256 `3c41e1d5458081bfa4a5bc54e116c46259c75c6760a18027764555632b9dda3e` |
| Windows v8.18.6 build/patches | `09cfccf20b91b441fbe97fa7a7ed8a597e55e830` |
| glib no-gregex patch | Official recipe's fixed gist revision `bdad5489a61c217850631571caf57f5db6ea8b2c` |
| libvips C++ SONAME patch | Official recipe's fixed gist revision `3988223c7dfa4d22745d9392034b0117abef1446` |
| Windows linking/development material | Official `vips-dev-x64-web-8.18.6-static.zip`, `@img/sharp-libvips-dev@1.3.3`, `@img/sharp-libvips-win32-x64@1.3.3` |
| MXE recipe snapshot | Observed referenced `llvm-mingw-20260605` branch at `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3`; **not attested as original binary build commit** |

On the audit date the official [sharp-libvips release](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.3)
lists only `npm-workspace.tar.xz` (86,027,240 bytes), not a separate per-platform
source-all archive. The official [Windows release](https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.6)
lists platform dev ZIPs, not a source-all bundle. Git source snapshots, component
release sources and the build recipes are consequently retained separately.

## Rebuild and replacement procedure (not executed here)

1. Obtain the common source sidecar and verify its release-bound hash. Use a new
   user-controlled work directory; never replace libraries in a live enterprise
   deployment for this exercise. Record target architecture, compiler/runtime
   versions, source hashes, commands, library hashes and process exit status.
2. For Linux/macOS, start with the pinned sharp-libvips `build.sh` and
   `build/posix.sh`, platform Dockerfiles/macOS options and the retained patches.
   Preserve its static-dependency choices and C++ shared-library/SONAME changes.
   Its native libheif build disables libde265/x265 and plugin loading: the separate
   HEIC/WASM build flags are not interchangeable. A user may instead build a
   compatible custom shared libvips and rebuild sharp against that prefix.
3. The [official sharp build route](https://sharp.pixelplumbing.com/install/#building-from-source)
   is `npm explore sharp -- npm run build`, with C++17, node-addon-api and node-gyp.
   Custom libvips discovery uses `pkg-config --modversion vips-cpp`; the npm source
   archive supplied here avoids needing to recreate sharp's generated JavaScript.
   Upstream explicitly does not support globally installed libvips on Windows or
   under macOS Rosetta. Use a separate source-build environment, not Otto's frozen
   package lock or production environment, for development tools.
4. For Windows x64, use the retained build-win64-mxe `vips-web` static recipe and
   its patches to create the replacement C library. Follow sharp-libvips
   `build/win.sh` and sharp `src/binding.gyp`: the latter rebuilds the C++ bridge
   with the Windows toolchain to match the C++ ABI. The retained dev package has
   the C++ source/headers; the Windows package has `libvips.lib` and
   `libvips-42.dll`. Do not substitute an unrelated `vips-all`/HEVC build or assume
   a generic global-library override works on Windows.
5. In the user's independent application build, replace the ABI-compatible
   library under `@img/sharp-libvips-<target>/lib` (Linux/macOS), or both required
   libvips/C++ DLLs under `@img/sharp-win32-x64/lib`. Desktop packaging deliberately
   keeps these native libraries and sharp outside ASAR. Verify the actual loaded
   native path/module list, not merely `sharp.versions` JSON. Use a harmless
   native source change with an observable runtime effect and assert it through
   a fresh application/worker process. Then run real PNG/JPEG/resize and the
   application's HEIC-to-JPEG path; retain image dimensions/pixel assertions.
6. Negative checks must fail for a missing required native library, wrong
   architecture/ABI, corrupt library and an unused decoy replacement. Preserve
   process time/memory bounds. An unchanged original library loading successfully
   is a baseline, not proof of modified-library replacement.

The complete Otto source and build/packaging scripts enable a separate user-built
application. User signing/trust configuration may be necessary on their own
system. No procedure above disables official signatures, native asset hashes,
update verification or managed deployment integrity. Whether installation
information is additionally required for a particular distribution remains a
distribution-specific LGPL/GPL assessment, not an assertion made by this audit.

## Exact audit limits and evidence

- `librsvg-c`/`rsvg` source is LGPL-2.1-or-later and is included in its source
  tarball. Its original Cargo.lock has 350 registry package entries, SHA256
  `fcca33feb66f75fb02199902cee0a5072cb491020d655463dfeffffc9d626941`, with no vendor
  directory. That does **not** establish 350 LGPL packages or 350 linked crates:
  the lock includes target, test and optional dependencies and has no per-crate
  license classification. The pinned POSIX recipe edits manifests and runs
  `cargo update --workspace`. Native `versions.json` does not identify the final
  Cargo lock or linked crate set. The original lock and unaltered recipe are
  preserved; no fabricated post-update lock, cargo execution or native rebuild
  is claimed. Original-lock crate checksums can support a separately labelled
  source cache, but cannot establish the exact prebuilt crate provenance.
- Windows' recipe defaults to an OCI `latest` image and a mutable MXE branch.
  Its exact build-recipe tag and an observed MXE source snapshot are available;
  the original image digest/MXE revision is not established. Normal system build
  tools are prerequisites, not recursively bundled here. Bitwise reproduction
  is not required or claimed.
- The upstream notices table identifies permissive libraries but does not itself
  contain all their copyright/license text. Preserve any accompanying originals;
  this inventory is not certification that every permissive notice obligation or
  all LGPL combination/relinking obligations have been discharged.
- Actual work: downloaded official archives, checked lengths/SHA256 (and locked
  npm SHA512), read archive members without executing them, compared all five
  target version inventories and reviewed source/build/link paths. No native
  rebuild or modified-library execution was performed.

Diagnostic evidence is outside the repository:
`D:/otto/diagnostics/sharp-license-audit-20260909/sharp-inputs-measured.json`,
`native-metadata.json`, `platform-and-cargo-evidence.json` and the retained input
archives. Earlier failed Node/curl downloads remain recorded; PowerShell's
certificate-validating client completed the downloads without a TLS bypass.
The shared sidecar manifest records the portable official URLs and measured
hashes; local paths are not required by recipients.
