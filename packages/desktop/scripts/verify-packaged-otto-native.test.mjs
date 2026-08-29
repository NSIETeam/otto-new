/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import asar from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyPackagedOttoNative } from './verify-packaged-otto-native.mjs';

const temporaryDirectories = [];

async function fixture({ omitModule = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-packaged-native-'));
  temporaryDirectories.push(root);
  const source = path.join(root, 'source');
  const moduleRoot = path.join(source, 'node_modules', '@otto', 'native');
  fs.mkdirSync(path.join(moduleRoot, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(moduleRoot, 'package.json'),
    JSON.stringify({
      name: '@otto/native',
      version: '0.1.0',
      type: 'commonjs',
      main: 'dist/index.js',
    }),
  );
  if (!omitModule) {
    fs.writeFileSync(
      path.join(moduleRoot, 'dist', 'index.js'),
      [
        'class NativeExport {}',
        "for (const name of ['SessionStore','EncryptionStore','OpenMlsNativeKernel','Tokenizer','AgentPool']) exports[name] = NativeExport;",
      ].join('\n'),
    );
  }
  const archivePath = path.join(root, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(source, archivePath);

  const binary = Buffer.alloc(70 * 1024);
  binary.write('MZ', 0, 'ascii');
  binary.writeUInt32LE(0x80, 0x3c);
  binary.write('PE\0\0', 0x80, 'binary');
  binary.writeUInt16LE(0x8664, 0x84);
  const targetDirectory = path.join(
    path.dirname(archivePath),
    'otto-native',
    'win32-x64',
  );
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(path.join(targetDirectory, 'otto-native.exe'), binary);
  fs.writeFileSync(
    path.join(targetDirectory, 'manifest.json'),
    JSON.stringify({
      format: 1,
      target: 'win32-x64',
      platform: 'win32',
      arch: 'x64',
      cargoTarget: 'x86_64-pc-windows-msvc',
      binary: 'otto-native.exe',
      buildCommit: 'a'.repeat(40),
      size: binary.length,
      sha256: createHash('sha256').update(binary).digest('hex'),
      packaged: {
        size: binary.length,
        sha256: createHash('sha256').update(binary).digest('hex'),
        signature: {
          kind: 'authenticode',
          verified: false,
        },
      },
      rustToolchain: '1.97.1',
      rustcVersion: 'rustc 1.97.1 (pinned test)',
      cargoVersion: 'cargo 1.97.1 (pinned test)',
    }),
  );
  return { archivePath, targetDirectory };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('packaged @otto/native verification', () => {
  it('loads the packaged JavaScript module and binds it to the exact native runtime', async () => {
    const { archivePath } = await fixture();
    const result = verifyPackagedOttoNative({
      archivePath,
      platform: 'win32',
      arch: 'x64',
      expectedBuildCommit: 'a'.repeat(40),
    });
    expect(result).toMatchObject({
      target: 'win32-x64',
      moduleVersion: '0.1.0',
      binaryBytes: 70 * 1024,
    });
  });

  it('fails closed when dist/index.js is absent from app.asar', async () => {
    const { archivePath } = await fixture({ omitModule: true });
    expect(() =>
      verifyPackagedOttoNative({
        archivePath,
        platform: 'win32',
        arch: 'x64',
      }),
    ).toThrow(/missing.*dist\/index\.js/u);
  });

  it('fails closed when the platform executable is absent', async () => {
    const { archivePath, targetDirectory } = await fixture();
    fs.rmSync(path.join(targetDirectory, 'otto-native.exe'));
    expect(() =>
      verifyPackagedOttoNative({
        archivePath,
        platform: 'win32',
        arch: 'x64',
      }),
    ).toThrow(/must contain only/u);
  });

  it('requires the package hook to record Authenticode signing for stable Windows builds', async () => {
    const { archivePath } = await fixture();
    expect(() =>
      verifyPackagedOttoNative({
        archivePath,
        platform: 'win32',
        arch: 'x64',
        requireAuthenticodeSigned: true,
      }),
    ).toThrow(/manifest verification failed/u);
  });
});
