/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Build and verify the small, platform-specific Rust runtime consumed by
 * @otto/native.  The staging directory is deliberately a two-file artifact;
 * Cargo target trees are never inputs to electron-builder.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const OTTO_NATIVE_MANIFEST_FORMAT = 1;
export const OTTO_NATIVE_MINIMUM_BINARY_BYTES = 64 * 1024;
export const OTTO_NATIVE_RELEASE_TOOLCHAIN = '1.97.1';

export const OTTO_NATIVE_TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    platform: 'win32',
    arch: 'x64',
    cargoTarget: 'x86_64-pc-windows-msvc',
    binary: 'otto-native.exe',
  }),
  'darwin-x64': Object.freeze({
    platform: 'darwin',
    arch: 'x64',
    cargoTarget: 'x86_64-apple-darwin',
    binary: 'otto-native',
  }),
  'darwin-arm64': Object.freeze({
    platform: 'darwin',
    arch: 'arm64',
    cargoTarget: 'aarch64-apple-darwin',
    binary: 'otto-native',
  }),
});

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

function fail(message) {
  throw new Error(`[otto-native-runtime] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    input: options.input,
    timeout: options.timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} exited ${result.status}` +
        (result.stderr ? `: ${result.stderr.trim()}` : ''),
    );
  }
  return String(result.stdout ?? '').trim();
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function requireCommit(value, label) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    fail(`${label} must be a full 40-character Git commit, got ${value ?? ''}`);
  }
  return normalized;
}

function requireToolchain(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/u.test(normalized)) {
    fail(`${label} must be an exact Rust version, got ${value ?? ''}`);
  }
  return normalized;
}

function currentCommit() {
  if (process.env.GITHUB_SHA) {
    return requireCommit(process.env.GITHUB_SHA, 'GITHUB_SHA');
  }
  return requireCommit(
    run('git', ['rev-parse', 'HEAD'], { capture: true }),
    'git HEAD',
  );
}

export function getOttoNativeTarget(target) {
  const definition = OTTO_NATIVE_TARGETS[target];
  if (!definition) {
    fail(
      `unsupported target ${target}; expected one of ${Object.keys(
        OTTO_NATIVE_TARGETS,
      ).join(', ')}`,
    );
  }
  return definition;
}

export function assertOttoNativeBinaryFormat(filePath, target) {
  const definition = getOttoNativeTarget(target);
  const bytes = readFileSync(filePath);
  if (bytes.length < OTTO_NATIVE_MINIMUM_BINARY_BYTES) {
    fail(`${target} binary is too small (${bytes.length} bytes): ${filePath}`);
  }

  if (definition.platform === 'win32') {
    if (bytes.subarray(0, 2).toString('ascii') !== 'MZ' || bytes.length < 64) {
      fail(`${target} binary is not PE/COFF: ${filePath}`);
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    if (
      peOffset + 6 > bytes.length ||
      bytes.subarray(peOffset, peOffset + 4).toString('binary') !== 'PE\0\0' ||
      bytes.readUInt16LE(peOffset + 4) !== 0x8664
    ) {
      fail(`${target} binary is not Windows x64 PE/COFF: ${filePath}`);
    }
    return;
  }

  if (bytes.subarray(0, 4).toString('hex') !== 'cffaedfe') {
    fail(`${target} binary is not a thin little-endian Mach-O 64 file`);
  }
  const expectedCpuType = definition.arch === 'arm64' ? 0x0100000c : 0x01000007;
  if (bytes.readUInt32LE(4) !== expectedCpuType) {
    fail(`${target} Mach-O CPU type does not match ${definition.arch}`);
  }
}

export function probeOttoNativeBinary(filePath) {
  const result = spawnSync(filePath, [], {
    encoding: 'utf8',
    input: `${JSON.stringify({ id: 1, method: 'ping' })}\n`,
    timeout: 20_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `native ping probe exited ${result.status}: ${String(result.stderr).trim()}`,
    );
  }
  const responseLine = String(result.stdout)
    .split(/\r?\n/u)
    .find((line) => line.trim());
  let response;
  try {
    response = JSON.parse(responseLine ?? '');
  } catch {
    fail(
      `native ping probe returned invalid JSON: ${responseLine ?? '<empty>'}`,
    );
  }
  if (
    response?.id !== 1 ||
    response?.result?.pong !== true ||
    response?.error
  ) {
    fail(`native ping probe returned an unexpected response: ${responseLine}`);
  }
}

export function verifyStagedOttoNativeAsset({
  root = path.join(repositoryRoot, 'native', 'otto-native'),
  target,
  expectedBuildCommit,
  expectedToolchain = OTTO_NATIVE_RELEASE_TOOLCHAIN,
  packaged = false,
  requireAuthenticodeSigned = false,
  requireCodeSignature = false,
  probe = false,
}) {
  const definition = getOttoNativeTarget(target);
  const targetDirectory = path.join(root, target);
  if (
    !existsSync(targetDirectory) ||
    !statSync(targetDirectory).isDirectory()
  ) {
    fail(`staged target directory is missing: ${targetDirectory}`);
  }
  const entries = readdirSync(targetDirectory, { withFileTypes: true });
  const expectedNames = [definition.binary, 'manifest.json'].sort();
  const actualNames = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    actualNames.join('\n') !== expectedNames.join('\n')
  ) {
    fail(
      `${target} staging directory must contain only ${expectedNames.join(
        ', ',
      )}; got ${actualNames.join(', ')}`,
    );
  }

  const binaryPath = path.join(targetDirectory, definition.binary);
  const manifestPath = path.join(targetDirectory, 'manifest.json');
  if (lstatSync(binaryPath).isSymbolicLink()) {
    fail(`${target} binary must not be a symbolic link`);
  }
  assertOttoNativeBinaryFormat(binaryPath, target);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const binarySize = statSync(binaryPath).size;
  const binarySha256 = sha256(binaryPath);
  const toolchain = requireToolchain(
    expectedToolchain,
    'expected Rust toolchain',
  );
  const packagedIdentity = packaged ? manifest.packaged : undefined;
  const expectedSignatureKind =
    definition.platform === 'win32' ? 'authenticode' : 'codesign';
  const expectedBinarySize = packaged ? packagedIdentity?.size : manifest.size;
  const expectedBinarySha256 = packaged
    ? packagedIdentity?.sha256
    : manifest.sha256;
  if (
    manifest.format !== OTTO_NATIVE_MANIFEST_FORMAT ||
    manifest.target !== target ||
    manifest.platform !== definition.platform ||
    manifest.arch !== definition.arch ||
    manifest.cargoTarget !== definition.cargoTarget ||
    manifest.binary !== definition.binary ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < OTTO_NATIVE_MINIMUM_BINARY_BYTES ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256 ?? '') ||
    expectedBinarySize !== binarySize ||
    expectedBinarySha256 !== binarySha256 ||
    (packaged &&
      (packagedIdentity?.signature?.kind !== expectedSignatureKind ||
        typeof packagedIdentity?.signature?.verified !== 'boolean')) ||
    (requireAuthenticodeSigned &&
      (expectedSignatureKind !== 'authenticode' ||
        packagedIdentity?.signature?.verified !== true)) ||
    (requireCodeSignature &&
      (expectedSignatureKind !== 'codesign' ||
        packagedIdentity?.signature?.verified !== true)) ||
    !/^[0-9a-f]{40}$/u.test(manifest.buildCommit ?? '') ||
    manifest.rustToolchain !== toolchain ||
    typeof manifest.rustcVersion !== 'string' ||
    !manifest.rustcVersion.startsWith(`rustc ${toolchain} `) ||
    typeof manifest.cargoVersion !== 'string' ||
    !manifest.cargoVersion.startsWith(`cargo ${toolchain} `)
  ) {
    fail(`${target} manifest verification failed`);
  }
  if (
    expectedBuildCommit &&
    manifest.buildCommit !==
      requireCommit(expectedBuildCommit, 'expected build commit')
  ) {
    fail(
      `${target} build commit mismatch: expected ${expectedBuildCommit}, got ${manifest.buildCommit}`,
    );
  }
  if (probe) probeOttoNativeBinary(binaryPath);
  return Object.freeze({
    target,
    targetDirectory,
    binaryPath,
    manifestPath,
    manifest,
  });
}

export function buildOttoNativeAsset({
  target,
  root = path.join(repositoryRoot, 'native', 'otto-native'),
  buildCommit = currentCommit(),
  toolchain = OTTO_NATIVE_RELEASE_TOOLCHAIN,
  probe = false,
}) {
  const definition = getOttoNativeTarget(target);
  const commit = requireCommit(buildCommit, 'build commit');
  const exactToolchain = requireToolchain(toolchain, 'Rust toolchain');
  if (exactToolchain !== OTTO_NATIVE_RELEASE_TOOLCHAIN) {
    fail(
      `Rust toolchain must match the pinned release toolchain ${OTTO_NATIVE_RELEASE_TOOLCHAIN}, got ${exactToolchain}`,
    );
  }
  run('rustup', [
    'run',
    exactToolchain,
    'cargo',
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    path.join(repositoryRoot, 'otto-native', 'Cargo.toml'),
    '--target',
    definition.cargoTarget,
  ]);
  const sourceBinary = path.join(
    repositoryRoot,
    'otto-native',
    'target',
    definition.cargoTarget,
    'release',
    definition.binary,
  );
  assertOttoNativeBinaryFormat(sourceBinary, target);

  const targetDirectory = path.join(root, target);
  rmSync(targetDirectory, { recursive: true, force: true });
  mkdirSync(targetDirectory, { recursive: true });
  const stagedBinary = path.join(targetDirectory, definition.binary);
  copyFileSync(sourceBinary, stagedBinary);
  if (definition.platform !== 'win32') chmodSync(stagedBinary, 0o755);
  const manifest = {
    format: OTTO_NATIVE_MANIFEST_FORMAT,
    target,
    platform: definition.platform,
    arch: definition.arch,
    cargoTarget: definition.cargoTarget,
    binary: definition.binary,
    buildCommit: commit,
    size: statSync(stagedBinary).size,
    sha256: sha256(stagedBinary),
    rustToolchain: exactToolchain,
    rustcVersion: run('rustup', ['run', exactToolchain, 'rustc', '--version'], {
      capture: true,
    }),
    cargoVersion: run('rustup', ['run', exactToolchain, 'cargo', '--version'], {
      capture: true,
    }),
  };
  writeFileSync(
    path.join(targetDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return verifyStagedOttoNativeAsset({
    root,
    target,
    expectedBuildCommit: commit,
    probe,
  });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const command = process.argv[2];
  const target = option('--target');
  const root = option('--root')
    ? path.resolve(process.cwd(), option('--root'))
    : path.join(repositoryRoot, 'native', 'otto-native');
  if (!target || !command) {
    fail(
      'usage: otto-native-runtime.mjs build|verify --target <target> [--root <directory>] [--build-commit <sha>] [--expected-build-commit <sha>] [--toolchain <version>] [--expected-toolchain <version>] [--probe]',
    );
  }
  const probe = process.argv.includes('--probe');
  const result =
    command === 'build'
      ? buildOttoNativeAsset({
          target,
          root,
          buildCommit: option('--build-commit') ?? currentCommit(),
          toolchain: option('--toolchain') ?? OTTO_NATIVE_RELEASE_TOOLCHAIN,
          probe,
        })
      : command === 'verify'
        ? verifyStagedOttoNativeAsset({
            root,
            target,
            expectedBuildCommit: option('--expected-build-commit'),
            expectedToolchain:
              option('--expected-toolchain') ?? OTTO_NATIVE_RELEASE_TOOLCHAIN,
            probe,
          })
        : fail(`unsupported command ${command}`);
  console.log(
    `[otto-native-runtime] verified ${result.target}: ${result.manifest.size} bytes sha256=${result.manifest.sha256}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
