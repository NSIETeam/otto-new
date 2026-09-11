# Enterprise archive metadata check

The 1.9.15 release run `34504355734` stopped in the enterprise package build,
before publishing or deploying. The archive scanner searched every byte for
`LIBARCHIVE.xattr.` / `SCHILY.xattr.`. The locked Linux libvips shared libraries
legitimately contain these strings as ordinary ELF data, not TAR attributes.
The earlier isolated-host startup fix passed the actual macOS build probe.

The builder now parses TAR headers and the byte-counted records of local/global
PAX metadata. Actual prohibited attribute keys still fail; ordinary file data,
file names and PAX comment values no longer produce false positives. Invalid
checksums, truncated entries, malformed metadata and hidden trailing data fail
closed. The helper belongs to both source dirtiness and source fingerprint
inputs. No dependencies, binaries or runtime business code were changed.

PAX size/sparse layout overrides are explicitly unsupported and rejected, so
an extractor cannot use different entry boundaries to hide attribute headers.
The generated package uses ordinary files within TAR's octal size limit.

Existing protections remain: `--no-xattrs`, `COPYFILE_DISABLE=1`, executable-mode
normalization, AppleDouble / `.DS_Store` exclusion, extraction and real server
bind/close of delivered bytes, signatures and subsequent Linux install canary.

Verification before review:

- Regression-first: 17 tests, 13 failing against the old byte scan, 4 passing.
- Focused helper, Sharp and installer suites: 119 passed; two existing
  platform-specific skips are not counted as proof.
- The preserved complete 144-package TAR (169,597,440 bytes, SHA-256
  `ec38f37effd08c153d0fe7cd20d3604d2eaf69b227e106ff00e2df643a5da4c9`)
  passes the new metadata inspection with its original libvips bytes unchanged.

These local checks do not substitute for a fresh formal release, actual
Windows upgrade cases, Linux installation or production/publication receipts.

## Full archive listings above 1 MiB

The next original release run `34551454348` passed metadata validation, desktop
packaging and macOS seals, then stopped at `tar -tzf` with a null exit status.
Its error contained a truncated listing above Node's default 1 MiB pipe limit.
The complete old payload with real-length release paths independently reproduced
`ENOBUFS`: the full 9,139-entry listing is 1,221,194 bytes. This did not deploy.

Only archive listing now uses a 16 MiB output limit and a 60-second timeout.
Spawn errors, nonzero exits, empty or incomplete output still fail closed;
partial stdout is never accepted or dumped into an enormous error message.
Every returned name remains checked, including AppleDouble and `.DS_Store`
entries after the former cutoff. Other build subprocess limits are unchanged.

The real TAR regression first failed with `ENOBUFS` in three cases (normal list
and two forbidden tail entries), with four failure-handling cases already
passing. After the fix all 11 listing cases pass, including missing/truncated
stdout. The four focused archive/dependency suites passed 42 cases with one
existing platform skip. The preserved full-payload reproduction and these
tests are not a substitute for the next actual macOS enterprise build.
