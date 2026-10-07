# Otto manifest-only compatibility patch

This is a modified dependency manifest, not an unchanged crates.io release.
The upstream package remains hpke-rs-libcrux 0.6.1 (MPL-2.0), from
https://crates.io/crates/hpke-rs-libcrux/0.6.1 . The original crate archive SHA-256
is `c0ce6b7e54aebe540faee869c67ee253bede44ea6cb67c6e72c7847d6c59f1df`;
upstream commit `f3463e7530771d7f7116635335c25e7d2d11e861`, directory
`libcrux_provider`. Upstream authors include Franziskus Kiefer.

Only the normalized Cargo.toml dependency requirements are modified:

- libcrux-aead: 0.0.7 -> =0.0.8, the official fixed release for
  RUSTSEC-2026-0124 / GHSA-hc3c-63hc-2r9f.
- libcrux-traits: 0.0.6 -> =0.0.7, matching that AEAD release's typed API.

All Rust implementation and benchmark source files are unchanged. The upstream
src/lib.rs SHA-256 is
`27606b7e8230159c685f381e92722cd8e7467fa00a929d994cd10cd0e6295fc5`.
Cargo.toml.orig preserves the original upstream manifest. The upstream
development Cargo.lock and Cargo cache marker are omitted: Otto's release
Cargo.lock is authoritative and is separately reviewed and scanned.

Otto continues using OpenMLS 0.8.1 / RustCrypto 0.5.1 for deployed MLS sessions.
This optional libcrux backend is tested as a development dependency, not enabled
in the release binary. No wire protocol, stored MLS state, device identity or
encryption key is changed by this manifest patch. Installation/upgrade acceptance
still independently checks those continuity requirements.

The MPL-2.0 license is retained in LICENSE-MPL-2.0.txt. This directory, including
its original source and modified manifest, is included in Otto's corresponding-
source archive. MPL-2.0 applies to this upstream code, not Otto's own independent
Apache-2.0 files. This is not a claim of external cryptographic audit or legal
certification. Remove the local manifest patch when a compatible upstream 0.6
release supplies these fixed dependency requirements.
