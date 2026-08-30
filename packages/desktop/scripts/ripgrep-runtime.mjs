/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  MACOS_RIPGREP_INTEGRITY,
  WINDOWS_RIPGREP_INTEGRITY,
} from './ripgrep-integrity.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');

export function readBundledRipgrepVersion(root = repoRoot) {
  const postinstall = path.join(
    root,
    'node_modules',
    '@vscode',
    'ripgrep',
    'lib',
    'postinstall.js',
  );
  const source = readFileSync(postinstall, 'utf8');
  const match = source.match(/^const VERSION = '([^']+)';/mu);
  if (!match) {
    throw new Error(
      `cannot determine bundled ripgrep version from ${postinstall}`,
    );
  }
  return match[1];
}

export function resolveRipgrepIntegrity(version, platform, arch) {
  if (platform === 'win32' && arch === 'x64') {
    return WINDOWS_RIPGREP_INTEGRITY[version];
  }
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    return MACOS_RIPGREP_INTEGRITY[version]?.[arch];
  }
  return undefined;
}

export function assertMachOArchitecture(bytes, arch, label = 'ripgrep') {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) {
    throw new Error(`${label} Mach-O header is truncated`);
  }
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`${label} is not a thin 64-bit Mach-O executable`);
  }
  const expectedCpuType =
    arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : undefined;
  if (expectedCpuType === undefined) {
    throw new Error(`unsupported macOS ${label} architecture: ${arch}`);
  }
  const actualCpuType = bytes.readUInt32LE(4);
  if (actualCpuType !== expectedCpuType) {
    throw new Error(
      `${label} Mach-O architecture mismatch: expected ${arch}, cpuType=0x${actualCpuType.toString(16)}`,
    );
  }
}

export function verifyRipgrepExecutable(
  filePath,
  {
    platform,
    arch,
    requireSourceDigest = false,
    version = readBundledRipgrepVersion(),
  },
) {
  const absolutePath = path.resolve(filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`packaged ripgrep is missing: ${absolutePath}`);
  }
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`ripgrep must be a regular file: ${absolutePath}`);
  }
  if (stat.size < 1024 * 1024 || stat.size > 16 * 1024 * 1024) {
    throw new Error(
      `ripgrep size is outside the release boundary: ${stat.size}`,
    );
  }

  const bytes = readFileSync(absolutePath);
  if (platform === 'win32') {
    if (arch !== 'x64' || bytes.subarray(0, 2).toString('ascii') !== 'MZ') {
      throw new Error(
        `ripgrep is not a Windows x64 executable: ${absolutePath}`,
      );
    }
  } else if (platform === 'darwin') {
    assertMachOArchitecture(bytes, arch);
  } else {
    throw new Error(`unsupported packaged ripgrep platform: ${platform}`);
  }

  const integrity = resolveRipgrepIntegrity(version, platform, arch);
  if (!integrity) {
    throw new Error(
      `no reviewed ripgrep integrity for ${version} ${platform}-${arch}`,
    );
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (requireSourceDigest && sha256 !== integrity.executableSha256) {
    throw new Error(
      `ripgrep source SHA256 mismatch: expected ${integrity.executableSha256}, got ${sha256}`,
    );
  }
  return { arch, platform, sha256, size: stat.size, version };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const fileArgument = process.argv[2];
  const platform = argumentValue('--platform');
  const arch = argumentValue('--arch');
  if (!fileArgument || !platform || !arch) {
    throw new Error(
      'usage: ripgrep-runtime.mjs <rg-path> --platform win32|darwin --arch x64|arm64 [--require-source-digest]',
    );
  }
  const result = verifyRipgrepExecutable(fileArgument, {
    platform,
    arch,
    requireSourceDigest: process.argv.includes('--require-source-digest'),
  });
  console.log(`[ripgrep-runtime] verified ${JSON.stringify(result)}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
