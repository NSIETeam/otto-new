#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FORMAT = 'otto-release-payload-signature-v1';

function normalizePublicKey(value) {
  const trimmed = value.trim().replace(/\\n/g, '\n');
  if (!trimmed) throw new Error('trusted public key is empty');
  if (trimmed.includes('BEGIN PUBLIC KEY')) return createPublicKey(trimmed);
  return createPublicKey({
    key: Buffer.from(trimmed, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function keyIdentity(publicKey) {
  return sha256(publicKey.export({ format: 'der', type: 'spki' })).slice(0, 16);
}

export async function signReleasePayload({
  inputPath,
  outputPath,
  privateKey,
}) {
  const resolvedInput = path.resolve(inputPath);
  const payload = await readFile(resolvedInput);
  const signingKey = createPrivateKey(privateKey.trim().replace(/\\n/g, '\n'));
  const publicKey = createPublicKey(signingKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('release payload signing key must be Ed25519');
  }
  const envelope = {
    format: FORMAT,
    algorithm: 'Ed25519',
    file: path.basename(resolvedInput),
    sha256: sha256(payload),
    keyId: keyIdentity(publicKey),
    signature: sign(null, payload, signingKey).toString('base64url'),
  };
  await writeFile(
    path.resolve(outputPath),
    `${JSON.stringify(envelope, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return envelope;
}

export async function verifyReleasePayload({
  inputPath,
  signaturePath,
  publicKey,
}) {
  const resolvedInput = path.resolve(inputPath);
  const payload = await readFile(resolvedInput);
  const envelope = JSON.parse(
    await readFile(path.resolve(signaturePath), 'utf8'),
  );
  const exactFields = [
    'algorithm',
    'file',
    'format',
    'keyId',
    'sha256',
    'signature',
  ];
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join(',') !== exactFields.join(',') ||
    envelope.format !== FORMAT ||
    envelope.algorithm !== 'Ed25519' ||
    envelope.file !== path.basename(resolvedInput) ||
    !/^[0-9a-f]{64}$/.test(envelope.sha256 || '') ||
    !/^[0-9a-f]{16}$/.test(envelope.keyId || '') ||
    typeof envelope.signature !== 'string'
  ) {
    throw new Error('release payload signature envelope is invalid');
  }
  const trustedKey = normalizePublicKey(publicKey);
  if (trustedKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('release payload trust key must be Ed25519');
  }
  if (keyIdentity(trustedKey) !== envelope.keyId) {
    throw new Error('release payload signing key mismatch');
  }
  if (sha256(payload) !== envelope.sha256) {
    throw new Error('release payload SHA-256 mismatch');
  }
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (
    signature.length !== 64 ||
    !verify(null, payload, trustedKey, signature)
  ) {
    throw new Error('release payload Ed25519 signature is invalid');
  }
  return envelope;
}

async function main() {
  const [command, inputPath, signaturePath, keyFile] = process.argv.slice(2);
  if (!['sign', 'verify'].includes(command) || !inputPath || !signaturePath) {
    throw new Error(
      'usage: release-payload-signature.mjs <sign|verify> <payload> <signature> [key-file]',
    );
  }
  if (command === 'sign') {
    const privateKey = keyFile
      ? await readFile(path.resolve(keyFile), 'utf8')
      : process.env.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!privateKey)
      throw new Error('release payload signing private key is missing');
    const result = await signReleasePayload({
      inputPath,
      outputPath: signaturePath,
      privateKey,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  const publicKey = keyFile
    ? await readFile(path.resolve(keyFile), 'utf8')
    : process.env.OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY?.replace(/\\n/g, '\n');
  if (!publicKey)
    throw new Error('release payload signing public key is missing');
  const result = await verifyReleasePayload({
    inputPath,
    signaturePath,
    publicKey,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`[release-payload-signature] ${error.message}\n`);
    process.exitCode = 3;
  });
}
