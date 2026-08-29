/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { verifyStagedOttoNativeAsset } from '../../../scripts/otto-native-runtime.mjs';

const requiredModuleEntries = Object.freeze([
  'node_modules/@otto/native/package.json',
  'node_modules/@otto/native/dist/index.js',
]);

function requireArchiveEntry(entries, archiveEntry) {
  const normalized = `/${archiveEntry.replaceAll('\\', '/')}`;
  if (!entries.has(normalized)) {
    throw new Error(`packaged @otto/native is missing ${archiveEntry}`);
  }
}

function extractArchiveFile(archivePath, archiveEntry) {
  return asar.extractFile(archivePath, archiveEntry.split('/').join(path.sep));
}

function loadPackagedNativeModule(archivePath) {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), 'otto-packaged-native-'),
  );
  try {
    const modulePath = path.join(temporaryDirectory, 'index.cjs');
    writeFileSync(
      modulePath,
      extractArchiveFile(
        archivePath,
        'node_modules/@otto/native/dist/index.js',
      ),
    );
    const nativeModule = createRequire(import.meta.url)(modulePath);
    for (const exportName of [
      'SessionStore',
      'EncryptionStore',
      'OpenMlsNativeKernel',
      'Tokenizer',
      'AgentPool',
    ]) {
      if (typeof nativeModule[exportName] !== 'function') {
        throw new Error(
          `packaged @otto/native export is missing or invalid: ${exportName}`,
        );
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function verifyPackagedOttoNative({
  archivePath,
  platform = process.platform,
  arch = process.arch,
  expectedBuildCommit = process.env.GITHUB_SHA,
  packaged = platform === 'win32',
  requireAuthenticodeSigned = false,
  requireCodeSignature = false,
  probe = false,
}) {
  const target = `${platform}-${arch}`;
  // electron-builder and tests can create more than one archive in the same
  // process. Never trust a cached ASAR filesystem/header from a previous read.
  asar.uncache(archivePath);
  const entries = new Set(
    asar.listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/')),
  );
  for (const entry of requiredModuleEntries) {
    requireArchiveEntry(entries, entry);
  }
  for (const forbiddenPrefix of [
    '/node_modules/@otto/native/src/',
    '/node_modules/@otto/native/target/',
    '/node_modules/@otto/native/bin/',
    '/node_modules/@otto/native/node_modules/',
  ]) {
    if ([...entries].some((entry) => entry.startsWith(forbiddenPrefix))) {
      throw new Error(
        `packaged @otto/native contains forbidden compiler/runtime input: ${forbiddenPrefix}`,
      );
    }
  }

  const packagedPackageBytes = extractArchiveFile(
    archivePath,
    'node_modules/@otto/native/package.json',
  );
  let packagedPackage;
  try {
    packagedPackage = JSON.parse(packagedPackageBytes.toString('utf8'));
  } catch {
    throw new Error(
      `packaged @otto/native package.json is invalid JSON (${packagedPackageBytes.length} bytes, prefix=${packagedPackageBytes.subarray(0, 8).toString('hex')})`,
    );
  }
  if (
    packagedPackage.name !== '@otto/native' ||
    packagedPackage.main !== 'dist/index.js'
  ) {
    throw new Error('packaged @otto/native package entry point is invalid');
  }
  loadPackagedNativeModule(archivePath);

  const resourcesRoot = path.dirname(archivePath);
  const verifiedAsset = verifyStagedOttoNativeAsset({
    root: path.join(resourcesRoot, 'otto-native'),
    target,
    expectedBuildCommit,
    packaged,
    requireAuthenticodeSigned,
    requireCodeSignature,
    probe,
  });
  return Object.freeze({
    target,
    moduleVersion: packagedPackage.version,
    binaryBytes:
      verifiedAsset.manifest.packaged?.size ?? verifiedAsset.manifest.size,
    binarySha256:
      verifiedAsset.manifest.packaged?.sha256 ?? verifiedAsset.manifest.sha256,
  });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const archiveArgument = process.argv[2];
  if (!archiveArgument) {
    throw new Error(
      'usage: verify-packaged-otto-native.mjs <app.asar> --platform <platform> --arch <arch> [--expected-build-commit <sha>] [--packaged] [--require-authenticode] [--require-code-signature] [--probe]',
    );
  }
  const platform = option('--platform') ?? process.platform;
  const arch = option('--arch') ?? process.arch;
  const result = verifyPackagedOttoNative({
    archivePath: path.resolve(process.cwd(), archiveArgument),
    platform,
    arch,
    expectedBuildCommit:
      option('--expected-build-commit') ?? process.env.GITHUB_SHA,
    packaged: process.argv.includes('--packaged'),
    requireAuthenticodeSigned: process.argv.includes('--require-authenticode'),
    requireCodeSignature: process.argv.includes('--require-code-signature'),
    probe: process.argv.includes('--probe'),
  });
  console.log(`[packaged-otto-native] verified ${JSON.stringify(result)}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
