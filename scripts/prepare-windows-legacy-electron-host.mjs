/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
// Historical test bytes only: never shipped and never permitted on a workstation.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const LEGACY_ELECTRON = Object.freeze({
  version: '43.2.0', bytes: 144326439,
  sha256: 'eba5f5088af40ecb364fe258809c79a5234c6ece5a75c64722772eba01b02786',
});

export function admittedHostDirectory(env, platform) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Windows') {
    throw new Error('GitHub-hosted Windows runner only; never run against a user installation');
  }
  if (!env.RUNNER_TEMP || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || '') || env.GITHUB_RUN_ATTEMPT !== '1') {
    throw new Error('Missing immutable hosted run identity');
  }
  const root = path.resolve(env.RUNNER_TEMP);
  if (root === path.parse(root).root) throw new Error('Unsafe fixture root');
  return path.join(root, 'otto-legacy-electron-host');
}

export function assertHistoricalZip(bytes) {
  if (bytes.length !== LEGACY_ELECTRON.bytes
    || createHash('sha256').update(bytes).digest('hex') !== LEGACY_ELECTRON.sha256) {
    throw new Error('Historical Electron byte identity mismatch');
  }
}

export async function historicalHostTools() {
  // These are Electron's declared tools, including its native-safe extractor.
  // Old extract-zip is no longer a dependency in the patched Electron release.
  const electronRequire = createRequire(createRequire(import.meta.url).resolve('electron/package.json'));
  const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href);
  const { extract } = await import(pathToFileURL(electronRequire.resolve('@electron-internal/extract-zip')).href);
  return { downloadArtifact, extract };
}

async function main() {
  let stage = 'admission';
  const enter = (value) => { stage = value; console.log(`OTTO_LEGACY_HOST_STAGE ${stage}`); };
  try {
  const directory = admittedHostDirectory(process.env, process.platform);
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('Redirected fixture path');
      if (cursor === directory) throw new Error('Historical host fixture must be new');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (cursor === path.dirname(cursor)) break;
  }
  mkdirSync(directory, { recursive: false });
  enter('download');
  // npm may nest these dependencies under Electron on a clean CI install.
  // Resolve from Electron's own dependency boundary, not accidental hoisting.
  const { downloadArtifact, extract } = await historicalHostTools();
  const zip = await downloadArtifact({
    version: LEGACY_ELECTRON.version, platform: 'win32', arch: 'x64', artifactName: 'electron',
    checksums: { 'electron-v43.2.0-win32-x64.zip': LEGACY_ELECTRON.sha256 },
    cacheRoot: path.join(directory, 'download-cache'),
    mirrorOptions: {
      mirror: 'https://github.com/electron/electron/releases/download/',
      customDir: 'v43.2.0',
    },
  });
  const stat = lstatSync(zip);
  enter('byte-identity');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== LEGACY_ELECTRON.bytes) {
    throw new Error('Historical Electron archive is not the bounded regular file');
  }
  assertHistoricalZip(readFileSync(zip));
  // Extraction is allowed only after checking the exact official archive bytes.
  enter('extract');
  await extract(zip, { dir: directory });
  const executable = path.join(directory, 'electron.exe');
  enter('runtime-version');
  const observed = spawnSync(executable, ['-p', 'process.versions.electron'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  if (observed.status !== 0 || observed.stdout.trim() !== LEGACY_ELECTRON.version) {
    throw new Error('Historical Electron runtime version mismatch');
  }
  writeFileSync(path.join(directory, 'host-receipt.json'), JSON.stringify({
    source: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID,
    version: LEGACY_ELECTRON.version, zipSha256: LEGACY_ELECTRON.sha256,
    executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  }), { flag: 'wx' });
  console.log('Pinned historical Electron test host verified; not a deliverable dependency.');
  } catch (error) {
    console.error(`OTTO_LEGACY_HOST_FAILURE ${stage}`);
    if (/^[A-Z0-9_-]{1,30}$/.test(error.code || '')) console.error(`OTTO_LEGACY_HOST_CODE ${error.code}`);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Do not log network exception URLs, signed CDN queries or credentials.
    console.error('Historical Electron host preparation rejected; nothing was executed unless byte identity passed.');
    process.exitCode = 1;
  });
}
