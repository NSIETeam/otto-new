/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prime @vscode/ripgrep's postinstall cache without exposing a GitHub token to
 * npm lifecycle scripts. The upstream installer trusts any file that happens
 * to exist in this cache, so this helper accepts only a reviewed package/
 * upstream-version pair and verifies both the archive and extracted executable
 * before publishing the cache entry atomically.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readBoundedResponseBody } from './fetch-mac-ripgrep.mjs';
import {
  resolveRipgrepIntegrity,
  verifyRipgrepExecutable,
} from './ripgrep-runtime.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const maximumArchiveBytes = 8 * 1024 * 1024;
const minimumArchiveBytes = 1024;
const downloadTimeoutMs = 60_000;
const maximumDownloadAttempts = 3;

const reviewedUpstreamVersionByPackage = Object.freeze({
  '1.17.0': 'v15.0.0',
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function resolveRipgrepInstallCacheSpec({
  packageLock,
  platform = process.platform,
  arch = process.env.npm_config_arch || os.arch(),
  temporaryDirectory = os.tmpdir(),
}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
    throw new Error(
      `unsupported release host for ripgrep cache: ${platform}-${arch}`,
    );
  }

  const packageVersion =
    packageLock?.packages?.['node_modules/@vscode/ripgrep']?.version;
  const upstreamVersion = reviewedUpstreamVersionByPackage[packageVersion];
  if (!upstreamVersion) {
    throw new Error(
      `unreviewed @vscode/ripgrep package version: ${packageVersion ?? 'missing'}`,
    );
  }

  const integrity = resolveRipgrepIntegrity(upstreamVersion, platform, arch);
  if (!integrity?.archiveSha256 || !integrity.executableSha256) {
    throw new Error(
      `missing reviewed ripgrep integrity for ${upstreamVersion} ${platform}-${arch}`,
    );
  }

  const archiveName = `ripgrep-${upstreamVersion}-${integrity.target}.tar.gz`;
  const cacheDirectory = path.join(
    temporaryDirectory,
    `vscode-ripgrep-cache-${packageVersion}`,
  );
  return Object.freeze({
    arch,
    archiveName,
    archivePath: path.join(cacheDirectory, archiveName),
    archiveSha256: integrity.archiveSha256,
    cacheDirectory,
    executableSha256: integrity.executableSha256,
    packageVersion,
    platform,
    target: integrity.target,
    upstreamVersion,
    url:
      `https://github.com/microsoft/ripgrep-prebuilt/releases/download/` +
      `${upstreamVersion}/${archiveName}`,
  });
}

export function assertReviewedRipgrepArchive(bytes, spec) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error('ripgrep archive must be a Buffer');
  }
  if (
    bytes.length < minimumArchiveBytes ||
    bytes.length > maximumArchiveBytes
  ) {
    throw new Error(
      `ripgrep archive size is outside the release boundary: ${bytes.length}`,
    );
  }
  const actual = sha256(bytes);
  if (actual !== spec.archiveSha256) {
    throw new Error(
      `ripgrep archive SHA256 mismatch: expected ${spec.archiveSha256}, got ${actual}`,
    );
  }
}

function ensurePrivateCacheDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !stat.isDirectory() ||
      (currentUid !== undefined && stat.uid !== currentUid)
    ) {
      throw new Error(
        `ripgrep cache is not an owned private directory: ${directory}`,
      );
    }
    fchmodSync(descriptor, 0o700);
  } catch (error) {
    throw new Error(
      `ripgrep cache is not an owned private directory: ${directory}`,
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function hasReviewedCachedArchive(spec) {
  if (!existsSync(spec.archivePath)) return false;
  let descriptor;
  try {
    descriptor = openSync(
      spec.archivePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(
        `ripgrep cache entry must be a regular file: ${spec.archivePath}`,
      );
    }
    return (
      stat.size >= minimumArchiveBytes &&
      stat.size <= maximumArchiveBytes &&
      sha256(readFileSync(descriptor)) === spec.archiveSha256
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function verifyExtractedExecutable(archivePath, stagingDirectory, spec) {
  const verificationDirectory = path.join(stagingDirectory, 'verify');
  mkdirSync(verificationDirectory, { mode: 0o700 });
  execFileSync(
    'tar',
    ['-xzf', archivePath, '-C', verificationDirectory, 'rg'],
    { stdio: 'pipe' },
  );
  const executable = path.join(verificationDirectory, 'rg');
  const stat = lstatSync(executable);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      'reviewed ripgrep archive did not produce a regular rg file',
    );
  }
  chmodSync(executable, 0o755);
  const result = verifyRipgrepExecutable(executable, {
    platform: spec.platform,
    arch: spec.arch,
    version: spec.upstreamVersion,
    requireSourceDigest: true,
  });
  if (result.sha256 !== spec.executableSha256) {
    throw new Error(
      'reviewed ripgrep executable identity changed unexpectedly',
    );
  }
}

async function downloadReviewedArchive(spec) {
  let lastError;
  for (let attempt = 1; attempt <= maximumDownloadAttempts; attempt += 1) {
    try {
      console.log(
        `[prime-vscode-ripgrep-cache] downloading ${spec.url} ` +
          `(attempt ${attempt}/${maximumDownloadAttempts})`,
      );
      const response = await fetch(spec.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(downloadTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(
          `download failed with HTTP ${response.status}: ${spec.url}`,
        );
        error.retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        throw error;
      }
      if (new URL(response.url).protocol !== 'https:') {
        await response.body?.cancel();
        const error = new Error(
          `download left the HTTPS boundary: ${response.url}`,
        );
        error.retryable = false;
        throw error;
      }
      const bytes = await readBoundedResponseBody(
        response,
        maximumArchiveBytes,
      );
      assertReviewedRipgrepArchive(bytes, spec);
      return bytes;
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt === maximumDownloadAttempts) {
        throw error;
      }
      await delay(attempt * 2_000);
    }
  }
  throw lastError ?? new Error('ripgrep download failed without an error');
}

async function primeCache(spec) {
  ensurePrivateCacheDirectory(spec.cacheDirectory);
  if (hasReviewedCachedArchive(spec)) {
    console.log(`[prime-vscode-ripgrep-cache] verified ${spec.archiveName}`);
    return;
  }

  const stagingDirectory = mkdtempSync(
    path.join(spec.cacheDirectory, '.staging-'),
  );
  const stagedArchive = path.join(stagingDirectory, spec.archiveName);
  try {
    const bytes = await downloadReviewedArchive(spec);
    writeFileSync(stagedArchive, bytes, { flag: 'wx', mode: 0o600 });
    verifyExtractedExecutable(stagedArchive, stagingDirectory, spec);

    renameSync(stagedArchive, spec.archivePath);
    if (!hasReviewedCachedArchive(spec)) {
      throw new Error(
        'ripgrep cache identity changed after atomic publication',
      );
    }
    console.log(
      `[prime-vscode-ripgrep-cache] ready ${spec.upstreamVersion} ${spec.arch}`,
    );
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const packageLock = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
  );
  await primeCache(resolveRipgrepInstallCacheSpec({ packageLock }));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      '[prime-vscode-ripgrep-cache] failed:',
      error?.message ?? error,
    );
    process.exit(1);
  });
}
