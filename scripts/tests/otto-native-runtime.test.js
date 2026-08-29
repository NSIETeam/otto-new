/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OTTO_NATIVE_RELEASE_TOOLCHAIN,
  OTTO_NATIVE_TARGETS,
  verifyStagedOttoNativeAsset,
} from '../otto-native-runtime.mjs';

const temporaryDirectories = [];

function fakeBinary(target) {
  const bytes = Buffer.alloc(70 * 1024);
  if (target === 'win32-x64') {
    bytes.write('MZ', 0, 'ascii');
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write('PE\0\0', 0x80, 'binary');
    bytes.writeUInt16LE(0x8664, 0x84);
  } else {
    Buffer.from('cffaedfe', 'hex').copy(bytes, 0);
    bytes.writeUInt32LE(target === 'darwin-arm64' ? 0x0100000c : 0x01000007, 4);
  }
  return bytes;
}

function fixture(target = 'win32-x64', manifestOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-native-runtime-'));
  temporaryDirectories.push(root);
  const definition = OTTO_NATIVE_TARGETS[target];
  const directory = path.join(root, target);
  fs.mkdirSync(directory, { recursive: true });
  const binary = fakeBinary(target);
  fs.writeFileSync(path.join(directory, definition.binary), binary);
  const manifest = {
    format: 1,
    target,
    platform: definition.platform,
    arch: definition.arch,
    cargoTarget: definition.cargoTarget,
    binary: definition.binary,
    buildCommit: 'a'.repeat(40),
    size: binary.length,
    sha256: createHash('sha256').update(binary).digest('hex'),
    rustToolchain: '1.97.1',
    rustcVersion: 'rustc 1.97.1 (pinned test)',
    cargoVersion: 'cargo 1.97.1 (pinned test)',
    ...manifestOverrides,
  };
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest)}\n`,
  );
  return { root, directory, definition };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Otto native release runtime', () => {
  it('pins the exact release Rust toolchain', () => {
    expect(OTTO_NATIVE_RELEASE_TOOLCHAIN).toBe('1.97.1');
  });

  it.each(['win32-x64', 'darwin-x64', 'darwin-arm64'])(
    'accepts a minimal, exact %s artifact',
    (target) => {
      const { root } = fixture(target);
      const result = verifyStagedOttoNativeAsset({
        root,
        target,
        expectedBuildCommit: 'a'.repeat(40),
      });
      expect(result.manifest.target).toBe(target);
      expect(result.manifest.size).toBe(70 * 1024);
    },
  );

  it('rejects target trees and every other unexpected artifact file', () => {
    const { root, directory } = fixture();
    fs.mkdirSync(path.join(directory, 'target'));
    expect(() =>
      verifyStagedOttoNativeAsset({ root, target: 'win32-x64' }),
    ).toThrow(/must contain only/u);
  });

  it('rejects a manifest that is not bound to the release commit', () => {
    const { root } = fixture();
    expect(() =>
      verifyStagedOttoNativeAsset({
        root,
        target: 'win32-x64',
        expectedBuildCommit: 'b'.repeat(40),
      }),
    ).toThrow(/build commit mismatch/u);
  });

  it('rejects a manifest built by any Rust toolchain other than the pin', () => {
    const { root } = fixture('win32-x64', {
      rustToolchain: '1.96.0',
      rustcVersion: 'rustc 1.96.0 (drifted test)',
      cargoVersion: 'cargo 1.96.0 (drifted test)',
    });
    expect(() =>
      verifyStagedOttoNativeAsset({ root, target: 'win32-x64' }),
    ).toThrow(/manifest verification failed/u);
  });

  it('requires a platform-specific packaged signature identity', () => {
    const binary = fakeBinary('darwin-arm64');
    const { root } = fixture('darwin-arm64', {
      packaged: {
        size: binary.length,
        sha256: createHash('sha256').update(binary).digest('hex'),
        signature: { kind: 'codesign', verified: true },
      },
    });
    const result = verifyStagedOttoNativeAsset({
      root,
      target: 'darwin-arm64',
      packaged: true,
      requireCodeSignature: true,
    });
    expect(result.manifest.packaged.signature).toEqual({
      kind: 'codesign',
      verified: true,
    });
  });

  it('rejects Authenticode metadata attached to a packaged Mac runtime', () => {
    const binary = fakeBinary('darwin-x64');
    const { root } = fixture('darwin-x64', {
      packaged: {
        size: binary.length,
        sha256: createHash('sha256').update(binary).digest('hex'),
        signature: { kind: 'authenticode', verified: true },
      },
    });
    expect(() =>
      verifyStagedOttoNativeAsset({
        root,
        target: 'darwin-x64',
        packaged: true,
        requireCodeSignature: true,
      }),
    ).toThrow(/manifest verification failed/u);
  });

  it('rejects PE binaries with the wrong machine architecture', () => {
    const { root, directory, definition } = fixture();
    const binaryPath = path.join(directory, definition.binary);
    const binary = fs.readFileSync(binaryPath);
    binary.writeUInt16LE(0x014c, 0x84);
    fs.writeFileSync(binaryPath, binary);
    expect(() =>
      verifyStagedOttoNativeAsset({ root, target: 'win32-x64' }),
    ).toThrow(/not Windows x64/u);
  });
});
