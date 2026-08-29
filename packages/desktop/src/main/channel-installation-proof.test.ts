/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  channelInstallationProofPayload,
  createChannelInstallationDeviceKeys,
  createChannelInstallationProof,
} from './channel-installation-proof.js';

describe('channel installation device proof', () => {
  it('signs exactly one pairing with a non-exported private-key proof', () => {
    const pairingId = 'pair_0123456789abcdef01234567';
    const keys = createChannelInstallationDeviceKeys();
    const proof = createChannelInstallationProof(pairingId, keys);

    expect(proof).not.toHaveProperty('privateKey');
    expect(
      verify(
        null,
        channelInstallationProofPayload(pairingId),
        createPublicKey(proof.installationPublicKey),
        Buffer.from(proof.signature, 'base64url'),
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        channelInstallationProofPayload('pair_abcdef0123456789abcdef01'),
        createPublicKey(proof.installationPublicKey),
        Buffer.from(proof.signature, 'base64url'),
      ),
    ).toBe(false);
  });

  it('rejects malformed pairing identifiers before signing', () => {
    expect(() =>
      createChannelInstallationProof(
        'pair_path-traversal',
        createChannelInstallationDeviceKeys(),
      ),
    ).toThrow('invalid channel pairing id');
  });
});
