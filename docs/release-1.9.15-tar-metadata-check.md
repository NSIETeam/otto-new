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
