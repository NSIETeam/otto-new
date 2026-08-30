/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedResponseBody } from './fetch-mac-ripgrep.mjs';
import {
  assertReviewedRipgrepArchive,
  resolveRipgrepInstallCacheSpec,
} from './prime-vscode-ripgrep-cache.mjs';
import {
  assertMachOArchitecture,
  readBundledRipgrepVersion,
  resolveRipgrepIntegrity,
} from './ripgrep-runtime.mjs';

function thinMachO(cpuType) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  return header;
}

describe('ripgrep runtime verification', () => {
  it('derives the npm postinstall cache only from reviewed package and target mappings', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../..',
    );
    const packageLock = JSON.parse(
      readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
    );

    expect(
      resolveRipgrepInstallCacheSpec({
        packageLock,
        platform: 'darwin',
        arch: 'arm64',
        temporaryDirectory: '/reviewed-temp',
      }),
    ).toMatchObject({
      packageVersion: '1.17.0',
      upstreamVersion: 'v15.0.0',
      target: 'aarch64-apple-darwin',
      archiveName: 'ripgrep-v15.0.0-aarch64-apple-darwin.tar.gz',
      archiveSha256:
        '16ded8d87db15333e8c06188ea2635dcde7f9869412f843e463a290f9d7493f3',
      cacheDirectory: path.join(
        '/reviewed-temp',
        'vscode-ripgrep-cache-1.17.0',
      ),
    });
    expect(
      resolveRipgrepInstallCacheSpec({
        packageLock,
        platform: 'darwin',
        arch: 'x64',
        temporaryDirectory: '/reviewed-temp',
      }),
    ).toMatchObject({
      upstreamVersion: 'v15.0.0',
      target: 'x86_64-apple-darwin',
      archiveName: 'ripgrep-v15.0.0-x86_64-apple-darwin.tar.gz',
      archiveSha256:
        '9787387f2d01ee3382e5984c39beb457f445585d81f928a5b1a089706ffb6c8f',
    });
    expect(() =>
      resolveRipgrepInstallCacheSpec({
        packageLock,
        platform: 'linux',
        arch: 'x64',
        temporaryDirectory: '/reviewed-temp',
      }),
    ).toThrow('unsupported release host');
    expect(() =>
      resolveRipgrepInstallCacheSpec({
        packageLock: {
          packages: {
            'node_modules/@vscode/ripgrep': { version: '99.0.0' },
          },
        },
        platform: 'darwin',
        arch: 'arm64',
        temporaryDirectory: '/reviewed-temp',
      }),
    ).toThrow('unreviewed @vscode/ripgrep package version');
  });

  it('rejects truncated and wrong-digest postinstall cache archives', () => {
    const spec = { archiveSha256: '0'.repeat(64) };
    expect(() =>
      assertReviewedRipgrepArchive(Buffer.alloc(1023), spec),
    ).toThrow('size is outside the release boundary');
    expect(() =>
      assertReviewedRipgrepArchive(Buffer.alloc(1024), spec),
    ).toThrow('SHA256 mismatch');
  });

  it('accepts only the requested thin 64-bit Mach-O architecture', () => {
    const arm64 = thinMachO(0x0100000c);
    const x64 = thinMachO(0x01000007);

    expect(() => assertMachOArchitecture(arm64, 'arm64')).not.toThrow();
    expect(() => assertMachOArchitecture(x64, 'x64')).not.toThrow();
    expect(() => assertMachOArchitecture(arm64, 'x64')).toThrow(
      'architecture mismatch',
    );
    expect(() => assertMachOArchitecture(x64, 'arm64')).toThrow(
      'architecture mismatch',
    );
  });

  it('rejects truncated, non-Mach-O, and unsupported architecture input', () => {
    expect(() => assertMachOArchitecture(Buffer.alloc(7), 'arm64')).toThrow(
      'header is truncated',
    );
    expect(() => assertMachOArchitecture(Buffer.alloc(8), 'arm64')).toThrow(
      'not a thin 64-bit Mach-O',
    );
    expect(() =>
      assertMachOArchitecture(thinMachO(0x0100000c), 'ia32'),
    ).toThrow('unsupported macOS ripgrep architecture');
  });

  it('pins reviewed v15.0.0 artifacts for both macOS targets', () => {
    expect(readBundledRipgrepVersion()).toBe('v15.0.0');
    expect(resolveRipgrepIntegrity('v15.0.0', 'darwin', 'arm64')).toEqual({
      target: 'aarch64-apple-darwin',
      archiveSha256:
        '16ded8d87db15333e8c06188ea2635dcde7f9869412f843e463a290f9d7493f3',
      executableSha256:
        '6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1',
    });
    expect(resolveRipgrepIntegrity('v15.0.0', 'darwin', 'x64')).toEqual({
      target: 'x86_64-apple-darwin',
      archiveSha256:
        '9787387f2d01ee3382e5984c39beb457f445585d81f928a5b1a089706ffb6c8f',
      executableSha256:
        'f999495980a5e6f1e7d26461ef5768b4013a62df610ed7d77a8b2de247a5b228',
    });
    expect(resolveRipgrepIntegrity('v15.0.0', 'win32', 'x64')?.target).toBe(
      'x86_64-pc-windows-msvc',
    );
    expect(
      resolveRipgrepIntegrity('v15.0.0', 'darwin', 'ia32'),
    ).toBeUndefined();
  });

  it('bounds archive downloads while streaming, independent of headers', async () => {
    await expect(
      readBoundedResponseBody(new Response(Buffer.alloc(8)), 8),
    ).resolves.toHaveLength(8);
    await expect(
      readBoundedResponseBody(new Response(Buffer.alloc(9)), 8),
    ).rejects.toThrow('exceeds the release boundary');
    await expect(
      readBoundedResponseBody(
        new Response(Buffer.alloc(1), {
          headers: { 'content-length': '9' },
        }),
        8,
      ),
    ).rejects.toThrow('declared size exceeds');
  });
});
