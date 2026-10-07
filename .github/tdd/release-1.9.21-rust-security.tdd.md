# 1.9.21 Rust dependency remediation (2026-10-07)

## Scope and user journey

The release candidate must not retain known affected Rust dependency versions,
while preserving the current MLS wire protocol, stored state, device identities,
keys and normal RustCrypto provider. These requirements were derived during the
authorized 1.9.21 release verification; there is no separate plan document.

Fresh Trivy 0.74.0 / official database updated 2026-10-06 found:

- HIGH GHSA-hc3c-63hc-2r9f / RUSTSEC-2026-0124:
  libcrux-chacha20poly1305 0.0.7, fixed in 0.0.8.
- LOW GHSA-rhfx-m35p-ff5j / RUSTSEC-2026-0002: lru 0.12.5,
  fixed in 0.16.3.

The first is an unused optional HPKE backend in the normal release dependency
graph, not a demonstrated exploit of Otto's deployed RustCrypto path. We still
repair the complete lock rather than waive or hide the finding. Neither public
update channels nor production services were changed by this remediation.

## RED checkpoint

`9ce3d6b159970b9e01509683c705b5f8d76cb941` records the new failing lock guards.

Actual command (Node 22.23.1, Vitest 4.1.11):

```
node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts scripts/tests/release-october-security.test.js
```

Result: 32 executed tests, 2 intended failures (cipher 0.0.7 and lru 0.12.5),
30 existing checks passed. The original scanner exited 1 with both findings.

`ac6b2d8cb10d6748d9bef5e13cb2afd52a609148` adds the installer/native test
prerequisites. Actual `native-integration-ci.test.js` execution ran 4 checks:
3 intended failures because CI, release quality and real installer builds only
built the native source without first running its behavior tests; 1 existing
identical-prerequisite check passed. GREEN now requires the complete locked Cargo
test target before building, without hiding optional-backend tests with `--lib`.

## Minimal remediation

- Pin lru =0.16.3; Cargo updates only its compatible hashbrown/foldhash closure.
- Retain OpenMLS =0.8.1, provider =0.5.1, HPKE =0.6.1 and all Otto crypto source.
- The compatible HPKE 0.6 line has no published backend patch adopting fixed
  AEAD dependencies. Import its verified MPL-2.0 optional backend source, without
  modifying any Rust implementation, and change exactly two normalized manifest
  requirements: libcrux-aead =0.0.8 and libcrux-traits =0.0.7.
- The local Cargo patch is explicitly identified as modified; its upstream
  archive checksum, commit, unchanged source hash, original manifest and full
  MPL-2.0 text are retained in `otto-native/vendor/hpke-rs-libcrux-0.6.1`.
- Add development-only compatibility tests; the backend is not enabled in the
  normal release binary. The fixed ChaCha/XChaCha primitive is exercised with
  synthetic overlong output buffers, including untouched tail assertions.

## Actual local GREEN evidence

| Guarantee | Executed verification | Result |
| --- | --- | --- |
| Fixed lock, transparent source identity and mandatory native tests before all installer builds | October security + native runtime + native CI contract tests | 49/49 PASS |
| Existing MLS persistence, outbox, trust boundaries and peer interoperability | `cargo +1.97.1 test --locked --offline --manifest-path otto-native/Cargo.toml` | 27 existing tests PASS |
| Optional AEAD round trips, tamper/AAD refusal, invalid input errors and both overlong-buffer fixes | Same Cargo command, `tests/libcrux_aead_compat.rs` | 3/3 PASS |
| Complete local release-script regression, including both new native workflow guards | `node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts --maxWorkers=1 --maxConcurrency=1` | 76 files PASS; 945 tests PASS, 32 existing platform skips, 0 failures |
| Entire Rust lock, not just deployed dependencies | Fresh Trivy 0.74.0, offline scan with official database | Exit 0, 200 packages, no vulnerability entries |
| Node/toolchain/source byte budget | `npm run doctor` with actual Node 22 npm CLI | PASS; 54.73 MB / unchanged 55 MB budget |
| Workspace map and whitespace | `npm run code-map`, `git diff --check` | PASS |

The NPM lock remains SHA-256
`d56ea3f52db33ad5cabbcc92aa4b0e2326176dac467a15fafc0f76862b931b41`.
No coverage baseline, minimum coverage, required test list, installer budget,
test timeout, vulnerability waiver, ignore rule or release exception is changed.

## Remaining acceptance and limitations

These dependency changes have no new first-party runtime branch to measure;
the complete native behavior suite and focused source/manifest checks were run.
Cloud native tests on supported targets, full mandatory CI, final source-bound
NSIS/DMG builds and real old-version upgrade acceptance must still run on this
new source before publication. The earlier c6ac64c8 package run is not final
acceptance for this repair. A passing scan is not legal certification, an
external crypto audit or proof of all possible future vulnerabilities.

Primary advisory references:
https://rustsec.org/advisories/RUSTSEC-2026-0124.html and
https://rustsec.org/advisories/RUSTSEC-2026-0002.html .
