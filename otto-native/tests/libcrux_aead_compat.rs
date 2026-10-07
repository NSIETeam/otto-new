// Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
// Exercise the optional manifest-patched backend, not production user keys.
use hpke_rs_crypto::{types::AeadAlgorithm, HpkeCrypto};
use hpke_rs_libcrux::HpkeLibcrux;

#[test]
fn patched_optional_backend_preserves_all_supported_aead_round_trips() {
    for (algorithm, key_len) in [
        (AeadAlgorithm::Aes128Gcm, 16),
        (AeadAlgorithm::Aes256Gcm, 32),
        (AeadAlgorithm::ChaCha20Poly1305, 32),
    ] {
        let key = vec![7; key_len];
        let nonce = [11; 12];
        let aad = b"synthetic-otto-compatibility";
        for plaintext in [&b""[..], &b"synthetic-only"[..]] {
            let ciphertext = HpkeLibcrux::aead_seal(algorithm, &key, &nonce, aad, plaintext)
                .expect("valid synthetic encryption");
            assert_eq!(ciphertext.len(), plaintext.len() + 16);
            assert_eq!(
                HpkeLibcrux::aead_open(algorithm, &key, &nonce, aad, &ciphertext)
                    .expect("valid synthetic decryption"),
                plaintext
            );
            let mut tampered = ciphertext.clone();
            tampered[0] ^= 1;
            assert!(HpkeLibcrux::aead_open(algorithm, &key, &nonce, aad, &tampered).is_err());
            assert!(HpkeLibcrux::aead_open(algorithm, &key, &nonce, b"wrong-aad", &ciphertext)
                .is_err());
        }
    }
}

#[test]
fn patched_optional_backend_rejects_invalid_inputs_without_panicking() {
    let algorithm = AeadAlgorithm::ChaCha20Poly1305;
    assert!(HpkeLibcrux::aead_seal(algorithm, &[0; 31], &[0; 12], b"", b"test").is_err());
    assert!(HpkeLibcrux::aead_seal(algorithm, &[0; 32], &[0; 11], b"", b"test").is_err());
    assert!(HpkeLibcrux::aead_open(algorithm, &[0; 32], &[0; 12], b"", &[0; 15]).is_err());
}

#[test]
fn fixed_chacha_variants_accept_overlong_destination_without_touching_the_tail() {
    let plaintext = b"synthetic-panic-regression";
    let required = plaintext.len() + 16;
    for extra in [1, 17] {
        let mut ciphertext = vec![0xa5; required + extra];
        let (body, tag) = libcrux_chacha20poly1305::encrypt(
            &[7; 32], plaintext, &mut ciphertext, b"synthetic-aad", &[11; 12],
        ).expect("fixed ChaCha accepts an overlong destination");
        assert_eq!(body.len(), plaintext.len());
        assert_eq!(tag.len(), 16);
        assert_eq!(&ciphertext[required..], vec![0xa5; extra]);

        let mut ciphertext = vec![0xa5; required + extra];
        let (body, tag) = libcrux_chacha20poly1305::xchacha20_poly1305::encrypt(
            &[7; 32], plaintext, &mut ciphertext, b"synthetic-aad", &[11; 24],
        ).expect("fixed XChaCha accepts an overlong destination");
        assert_eq!(body.len(), plaintext.len());
        assert_eq!(tag.len(), 16);
        assert_eq!(&ciphertext[required..], vec![0xa5; extra]);
    }
}
