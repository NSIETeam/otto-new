/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fetch both reviewed macOS ripgrep targets into vendor/mac/ripgrep/<arch>/.
 * A single @vscode/ripgrep install only contains the host architecture, while
 * Otto builds arm64 and x64 DMGs from one checkout. Keeping two verified inputs
 * prevents a host binary from leaking into the other target package.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  readBundledRipgrepVersion,
  resolveRipgrepIntegrity,
  verifyRipgrepExecutable,
} from './ripgrep-runtime.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const vendorRoot = path.join(desktopRoot, 'vendor', 'mac', 'ripgrep');
const supportedArchitectures = Object.freeze(['arm64', 'x64']);
const maxArchiveBytes = 8 * 1024 * 1024;
const downloadTimeoutMs = 60_000;

function selectedArchitectures() {
  const selected = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--arch')
      selected.push(process.argv[index + 1]);
  }
  const architectures =
    selected.length > 0 ? [...new Set(selected)] : [...supportedArchitectures];
  if (
    architectures.length === 0 ||
    architectures.some((arch) => !supportedArchitectures.includes(arch))
  ) {
    throw new Error(`unsupported macOS ripgrep architecture: ${architectures}`);
  }
  return architectures;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertDigest(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} SHA256 mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

export async function readBoundedResponseBody(
  response,
  maxBytes = maxArchiveBytes,
) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(
      `ripgrep archive declared size exceeds the release boundary: ${declaredLength}`,
    );
  }
  if (!response.body) {
    throw new Error('ripgrep archive response body is missing');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw new Error(
        `ripgrep archive streamed size exceeds the release boundary: ${total}`,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function fetchArchitecture(version, arch, force) {
  const integrity = resolveRipgrepIntegrity(version, 'darwin', arch);
  if (!integrity?.archiveSha256 || !integrity.executableSha256) {
    throw new Error(`no reviewed macOS ripgrep asset for ${version} ${arch}`);
  }

  const destination = path.join(vendorRoot, arch);
  const executable = path.join(destination, 'rg');
  const versionStamp = path.join(destination, '.version');
  if (
    !force &&
    existsSync(executable) &&
    existsSync(versionStamp) &&
    readFileSync(versionStamp, 'utf8').trim() === version
  ) {
    verifyRipgrepExecutable(executable, {
      platform: 'darwin',
      arch,
      version,
      requireSourceDigest: true,
    });
    console.log(`[fetch-mac-ripgrep] verified cached ${version} ${arch}`);
    return;
  }

  mkdirSync(vendorRoot, { recursive: true });
  const staging = mkdtempSync(path.join(vendorRoot, `.staging-${arch}-`));
  const archiveName = `ripgrep-${version}-${integrity.target}.tar.gz`;
  const archivePath = path.join(staging, archiveName);
  const stagedExecutable = path.join(staging, 'rg');
  const url = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${version}/${archiveName}`;

  try {
    console.log(`[fetch-mac-ripgrep] downloading ${url}`);
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(downloadTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}: ${url}`);
    }
    const archiveBytes = await readBoundedResponseBody(response);
    if (archiveBytes.length < 1024) {
      throw new Error(
        `ripgrep archive size is outside the release boundary: ${archiveBytes.length}`,
      );
    }
    assertDigest(
      sha256(archiveBytes),
      integrity.archiveSha256,
      `${version} ${arch} archive`,
    );
    writeFileSync(archivePath, archiveBytes);
    execFileSync('tar', ['-xzf', archivePath, '-C', staging, 'rg'], {
      stdio: 'inherit',
    });
    if (
      !existsSync(stagedExecutable) ||
      lstatSync(stagedExecutable).isSymbolicLink()
    ) {
      throw new Error(
        'reviewed ripgrep archive did not produce a regular rg file',
      );
    }
    chmodSync(stagedExecutable, 0o755);
    verifyRipgrepExecutable(stagedExecutable, {
      platform: 'darwin',
      arch,
      version,
      requireSourceDigest: true,
    });

    mkdirSync(destination, { recursive: true });
    const replacement = path.join(destination, `.rg-new-${process.pid}`);
    copyFileSync(stagedExecutable, replacement);
    chmodSync(replacement, 0o755);
    rmSync(executable, { force: true });
    renameSync(replacement, executable);
    writeFileSync(versionStamp, `${version}\n`, 'utf8');
    verifyRipgrepExecutable(executable, {
      platform: 'darwin',
      arch,
      version,
      requireSourceDigest: true,
    });
    console.log(`[fetch-mac-ripgrep] ready ${version} ${arch}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const version = readBundledRipgrepVersion();
  const force = process.argv.includes('--force');
  for (const arch of selectedArchitectures()) {
    await fetchArchitecture(version, arch, force);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error('[fetch-mac-ripgrep] failed:', error.message ?? error);
    process.exit(1);
  });
}
