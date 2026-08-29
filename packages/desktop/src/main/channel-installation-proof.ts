/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Device-bound proof for QR channel installation. The private key never leaves
 * the Desktop main process; the server receives only the public key and a
 * signature scoped to one pairing id.
 */

import { generateKeyPairSync, sign } from 'node:crypto';

export interface ChannelInstallationDeviceKeys {
  publicKey: string;
  privateKey: string;
}

const PAIRING_ID_PATTERN = /^pair_[a-f0-9]{24}$/;

export function channelInstallationProofPayload(pairingId: string): Buffer {
  if (!PAIRING_ID_PATTERN.test(pairingId)) {
    throw new Error('invalid channel pairing id');
  }
  return Buffer.from(`otto-channel-install-v1:${pairingId}`, 'utf8');
}

export function createChannelInstallationDeviceKeys(): ChannelInstallationDeviceKeys {
  const keys = generateKeyPairSync('ed25519');
  return {
    publicKey: keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    privateKey: keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}

export function createChannelInstallationProof(
  pairingId: string,
  keys: ChannelInstallationDeviceKeys,
): { installationPublicKey: string; signature: string } {
  return {
    installationPublicKey: keys.publicKey,
    signature: sign(
      null,
      channelInstallationProofPayload(pairingId),
      keys.privateKey,
    ).toString('base64url'),
  };
}
