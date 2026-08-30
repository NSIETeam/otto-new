import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  signReleasePayload,
  verifyReleasePayload,
} from '../release-payload-signature.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'otto-release-signature-'));
  temporaryDirectories.push(directory);
  const payload = path.join(directory, 'SHA256SUMS');
  const signature = `${payload}.sig`;
  writeFileSync(payload, `${'a'.repeat(64)}  Otto-Setup-1.9.14-win-x64.exe\n`);
  const keys = generateKeyPairSync('ed25519');
  return {
    payload,
    signature,
    privateKey: keys.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
    publicKey: keys.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString(),
  };
}

describe('signed release payload contract', () => {
  it('signs and verifies the exact immutable payload', async () => {
    const input = fixture();
    await signReleasePayload({
      inputPath: input.payload,
      outputPath: input.signature,
      privateKey: input.privateKey,
    });
    await expect(
      verifyReleasePayload({
        inputPath: input.payload,
        signaturePath: input.signature,
        publicKey: input.publicKey,
      }),
    ).resolves.toMatchObject({
      format: 'otto-release-payload-signature-v1',
      algorithm: 'Ed25519',
      file: 'SHA256SUMS',
    });
  });

  it('rejects payload tampering, key substitution, and envelope extension', async () => {
    const input = fixture();
    await signReleasePayload({
      inputPath: input.payload,
      outputPath: input.signature,
      privateKey: input.privateKey,
    });
    writeFileSync(input.payload, 'tampered\n');
    await expect(
      verifyReleasePayload({
        inputPath: input.payload,
        signaturePath: input.signature,
        publicKey: input.publicKey,
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);

    const replacement = generateKeyPairSync('ed25519').publicKey.export({
      format: 'pem',
      type: 'spki',
    });
    await expect(
      verifyReleasePayload({
        inputPath: input.payload,
        signaturePath: input.signature,
        publicKey: replacement.toString(),
      }),
    ).rejects.toThrow(/key mismatch/);

    const envelope = JSON.parse(readFileSync(input.signature, 'utf8'));
    envelope.publicKey = input.publicKey;
    writeFileSync(input.signature, JSON.stringify(envelope));
    await expect(
      verifyReleasePayload({
        inputPath: input.payload,
        signaturePath: input.signature,
        publicKey: input.publicKey,
      }),
    ).rejects.toThrow(/envelope is invalid/);
  });
});
