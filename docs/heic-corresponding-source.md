# HEIC and sharp/libvips source, notices and recombination

This document accompanies Otto's separate `otto-<version>-corresponding-source.tar.gz`
download. It is an engineering delivery description, not legal certification. The
release preserves the official heic-decode ISC declaration despite its known missing
standalone license text; no author copyright line or grant is invented. Full LGPL,
GPL and upstream runtime notices accompany the application in `NOTICE`.

Only the NOTICE display copy removes one trailing space after "written permission."
in the Emscripten license; words and paragraphs are unchanged. The upstream source
sidecar preserves the exact original file and hash. The NOTICE gate separately pins
the display copy's complete text, without a whitespace-gate exception.

## What is in the source sidecar

- `otto-source.tar.gz`: **all tracked files of the exact clean release HEAD**, with
  the original repository-relative layout under `otto-source/`. Ignored files,
  credentials outside Git, working changes, installed dependencies and build outputs
  are not swept into this archive. An export-ignore omission or unpopulated Git
  submodule makes construction fail; it is not described as complete source.
- `source-inputs.json`: source commit, complete tracked path/mode/Git-blob inventory,
  source archive SHA256, exact package-lock SHA256, resolved codec dependency records,
  pinned upstream origins/hashes and sidecar builder environment.
- `package-lock.json`: the **committed** lock bytes from that HEAD, also present in
  the complete application archive. All application package manifests, build scripts,
  workflow inputs and checked-in native/build instructions are in the full archive.
- `upstream/`: complete pinned archives and license documents listed in
  `upstream-inputs.json`. The libheif Git submodule source is supplied separately:
  GitHub's libheif-emscripten archive does not expand submodules.
- `NOTICE` and this `README.md`: license/attribution texts and rebuild instructions.
- `SHARP-LIBVIPS.md`: the native stack's reviewed source/build/relinking routes,
  actual five-target component versions, and explicit upstream provenance limits.
  The same full document is in `otto-source.tar.gz`.

### Extracting the application source on Windows

The Git source archive preserves long UTF-8 names using PAX metadata. In the
2026-09-09 Windows check, built-in bsdtar 3.8.4 extracted the outer sidecar but
failed to extract one long Chinese path from `otto-source.tar.gz`. GNU tar 1.35
extracted all 3,434 files of the tested snapshot, and every file matched its Git
blob. Use GNU tar (verify `tar --version`) or an isolated Linux environment for
the inner archive; an extraction error is not permission to omit or rename source
files. Verify the extracted inventory against `source-inputs.json`. These checks
do not claim every Windows archive application is compatible.

Publish the sidecar and its `.sha256` alongside **each binary release download**,
with clear links and equivalent no-additional-charge access. The sidecar is not
inside the installer and is not counted against the installer-size ceiling. Keep
its source available as required; a local cache or a list of mutable third-party
URLs is not itself recipient delivery. [GPL 3 section 6](https://www.gnu.org/licenses/gpl-3.0.html).

## Official source chain and exact build inputs

The committed `scripts/heic-corresponding-source-inputs.json` pins every archive's
HTTPS URL, exact byte length and SHA256 (plus npm SHA512 where applicable).

| Source                                                                                                                       | Exact commit / version                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [heic-decode](https://github.com/catdad-experiments/heic-decode/tree/47773f7b17acc22bfb8bb7869b6ef087d24c0ca9)               | 2.1.0 / `47773f7b17acc22bfb8bb7869b6ef087d24c0ca9`                                                   |
| [libheif-js](https://github.com/catdad-experiments/libheif-js/tree/6ca00b818c0ff51cb2a5c75b9ce97d708083335a)                 | 1.23.2 / `6ca00b818c0ff51cb2a5c75b9ce97d708083335a`                                                  |
| [libheif-emscripten](https://github.com/catdad-experiments/libheif-emscripten/tree/dd5a19b878149437a5a427f6e1afa8bac624a714) | v1.23.2 / `dd5a19b878149437a5a427f6e1afa8bac624a714`                                                 |
| [libheif](https://github.com/strukturag/libheif/tree/ac1cb05c39008f01525c991ff8b88f84ddf70fd2)                               | 1.23.2 / `ac1cb05c39008f01525c991ff8b88f84ddf70fd2`                                                  |
| [libde265](https://github.com/strukturag/libde265/tree/17bb8d9fcea62db8cdeb0fc7ef8d15dbd19a22e4)                             | 1.0.15 / `17bb8d9fcea62db8cdeb0fc7ef8d15dbd19a22e4`; exact original release source tar also supplied |
| [emsdk](https://github.com/emscripten-core/emsdk/tree/ca7b40ae222a2d8763b6ac845388744b0e57cfb7)                              | 3.1.61 / `ca7b40ae222a2d8763b6ac845388744b0e57cfb7`                                                  |
| [Emscripten](https://github.com/emscripten-core/emscripten/tree/67fa4c16496b157a7fc3377afd69ee0445e8a6e3)                    | 3.1.61 / `67fa4c16496b157a7fc3377afd69ee0445e8a6e3`                                                  |

The actual npm WASM is SHA256
`e4aa8333fbe55ec7c6c776f735236f40bed9103188498f8131d4e52b73cdfee8` (1,422,377
bytes), equal to the official libheif-emscripten release binary. Its exact base64
bytes also appear in the CJS and ESM bundles. This asset comparison is **not** an
independent recompilation proof.

The pinned upstream workflow runs Ubuntu 22.04, Node 24, TypeScript `@5` and
Emscripten 3.1.61. Its two jobs set `USE_WASM=0` or `1`, `USE_UNSAFE_EVAL=0` and
`USE_TYPESCRIPT=1`. `build-emscripten.sh` defaults to libde265 1.0.15 enabled; AOM,
WebCodecs, OpenJPEG and uncompressed support are disabled in this workflow. The
static libde265 build uses `emconfigure`, `--enable-static --disable-shared
--disable-sse --disable-dec265 --disable-sherlock265` and `CXXFLAGS=-O3`. libheif
CMake disables shared libraries, multithreading, examples, GDK pixbuf and plugin
loading. `emcc` links libheif.a and libde265.a, embind and post.js, with `-O3`,
synchronous WASM initialization and `ALLOW_MEMORY_GROWTH`.

## Rebuild the library in an isolated user-controlled environment

Do not run upstream sudo/install/cleanup scripts in a shared checkout or on the
production server. The following is the reviewed build route, **not a statement
that Otto has recompiled this upstream WASM bit-identically**:

1. Verify archive hashes using `upstream-inputs.json`. Unpack the pinned build
   wrapper, populate its `libheif/` directory from the separately pinned libheif
   archive, and keep all original headers/COPYING files. Preserve any user patches.
2. Install/activate the pinned emsdk 3.1.61 in an isolated Linux builder. The exact
   upstream instructions are libheif's `scripts/install-emscripten.sh`,
   `scripts/install-ci-linux.sh`, `scripts/prepare-ci.sh`, and `scripts/run-ci.sh`.
   Retain the SDK/runtime licenses. Ordinary unmodified compiler tools are distinct
   from runtime code incorporated into the library.
3. Reproduce the pinned `.github/workflows/emscripten.yml` jobs. Preseed the
   hash-verified `libde265-1.0.15-source-release.tar.gz` under the expected local
   name `libde265-1.0.15.tar.gz` in each build directory, so the library build uses
   the supplied source. Run `build-emscripten.sh <libheif-source-dir>` with the
   corresponding workflow environment above. A small explicit `CORES` limits
   build parallelism. `dist-prep.sh` documents the exact layout of JS, declarations,
   COPYING and WASM in `libheif/` and `libheif-wasm/`.
4. Combine those two directories into a local tar.gz. In the supplied libheif-js
   source, install its build dependencies in isolation and run
   `node scripts/install.js <absolute-local-tar.gz>`. This script accepts the local
   archive; there is no need to substitute a remote origin. It minifies at es2019
   and uses `scripts/bundle.js` with esbuild's binary loader to embed WASM in the
   active CJS bundle and ESM bundle. Retain the library's licenses when packing it.
5. Record actual resolved build dependencies and tool versions. Upstream has no
   committed npm build lock; esbuild `^0.19.5`, polyfill `^1.6.7`, TypeScript `@5`
   and runner images are not fully pinned. Newly resolved tools may not reproduce
   byte-identical JS. Distinguish functional recombination from byte reproducibility.

## Recombine with Otto without weakening production trust

The application source is supplied under its original Apache-2.0 terms, while
upstream libraries retain their own licenses. This supports the corresponding
source/application-code route in [LGPL 3 section 4(d)(0)](https://www.gnu.org/licenses/lgpl-3.0.html).
No term in this notice restricts modification of the LGPL portions or reverse
engineering to debug those modifications.

In a separate clean directory, extract `otto-source.tar.gz`, use the supplied
package-lock and the documented Node version (`package.json` / release workflows),
and run `npm ci`. Install a user-built compatible libheif-js package into **that
independent copy**, record the local dependency change, then rebuild using the
supplied package scripts (`npm run build:packages`, and desktop package build/
distribution scripts as appropriate). All repository build utilities accompany the
source. Native platform prerequisites and ordinary external tools are documented
in those workflows/scripts; this sidecar does not contain production private keys.

Active path: the image worker resolves `heic-decode`, whose index loads
`libheif-js/wasm-bundle`, which instantiates `libheif-wasm/libheif-bundle.js`.
The binary is embedded in the JS bundle. Replacing only the separate `.wasm` file
does **not** replace the active library; use the rebuilt bundle/package.

For a concrete, non-production check with the supplied official archives:

```sh
node scripts/test-heic-recombination.mjs --cache-dir /absolute/path/to/upstream
```

This physically creates an independent Node installation from the two verified
npm tarballs, decodes the official libheif example, modifies the active wrapper
with a harmless observable marker, and decodes again. It requires the marker to
be observed and pixel hashes to remain equal. A negative control proves changing
only the unused `.wasm` does not affect this path; truncated HEIC remains rejected.
It does not modify shared node_modules, an installed application, or a trust store.
This verifies the actual library/application-adapter recombination path, **not**
a rebuilt WASM nor execution of a modified final signed desktop installation.

Managed production files remain immutable and signature/manifest gates remain
strict. A user-controlled build is a separate installation and must use its own
configuration/signing route as applicable; do not edit a managed release in place.
If a particular distribution requires Installation Information under LGPL 4(e)
and GPL 6, assess and provide a legally adequate installation mechanism. This
document does not certify that assessment or promise official update support for
a modified installation.

## Official build interface and limits

```sh
node scripts/build-heic-corresponding-source.mjs \
  --output-dir /absolute/outside-checkout/output \
  --cache-dir /absolute/outside-checkout/verified-cache
```

The CLI accepts no arbitrary source URL, version override, dirty-HEAD exception
or upstream execution option. It verifies every cache/download's exact length and
digest before inclusion. It records the final clean HEAD and rejects staged,
unstaged, untracked, omitted or changed source. Output and cache must be outside
the checkout. stdout is JSON with `archivePath`, `sha256Path`, `sourceCommit`,
`version`, `sha256`; assets are never silently overwritten. Each installer/ASAR
must independently retain NOTICE and the shipped dependency license files.

The shared manifest now also supplies 21 reviewed sharp/libvips source, build,
patch, development/linking and license inputs. Its five shipped native-target
records are checked against the exact release lock before construction. See
`SHARP-LIBVIPS.md` (or `docs/sharp-libvips-corresponding-source-audit-20260909.md`
in the full application source) for the native rebuild procedure and limits.
This is not a native rebuild/replacement execution proof or an assertion that
upstream's post-update Cargo lock, linked crate set, Windows MXE build revision
or build image digest have been fully recovered. `source-inputs.json` explicitly
records these non-attestations. The upstream ISC text gap,
toolchain byte-reproduction limitations, final-installation testing and any
applicable legal review remain explicitly distinguishable from these engineering
checks. No codec patent analysis is claimed.
