import { createHash } from 'node:crypto';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPDATE_MIRROR_MANIFEST_FORMAT = 'otto-update-mirror-payload-v1';

export function updateMirrorAssetNames(version) {
  assertVersion(version);
  return [
    `Otto-${version}-arm64.dmg`,
    `Otto-${version}-arm64.dmg.blockmap`,
    `Otto-${version}-x64.dmg`,
    `Otto-${version}-x64.dmg.blockmap`,
    `Otto-Setup-${version}-win-x64.exe`,
    `Otto-Setup-${version}-win-x64.exe.blockmap`,
    'latest.json',
  ];
}

function assertVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('update mirror manifest version is invalid');
  }
}

function assertPackageIdentity(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{12}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('update mirror manifest packageIdentity is invalid');
  }
}

function assertSourceCommit(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('update mirror manifest sourceCommit is invalid');
  }
}

function assertExactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} fields are not exact`);
  }
}

async function digestRegularFile(filePath) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(
      `update mirror asset is not a regular non-symlink file: ${path.basename(filePath)}`,
    );
  }
  if (!Number.isSafeInteger(before.size) || before.size < 1) {
    throw new Error(
      `update mirror asset size is invalid: ${path.basename(filePath)}`,
    );
  }
  const handle = await open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(
        `update mirror asset changed while opening: ${path.basename(filePath)}`,
      );
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(
        `update mirror asset changed while hashing: ${path.basename(filePath)}`,
      );
    }
    return { size: opened.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

export function serializeUpdateMirrorManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function createUpdateMirrorManifest({
  assetDirectory,
  version,
  packageIdentity,
  sourceCommit,
}) {
  assertVersion(version);
  assertPackageIdentity(packageIdentity);
  assertSourceCommit(sourceCommit);
  const assets = [];
  for (const name of updateMirrorAssetNames(version)) {
    const { size, sha256 } = await digestRegularFile(
      path.join(assetDirectory, name),
    );
    assets.push({ name, size, sha256 });
  }
  return {
    format: UPDATE_MIRROR_MANIFEST_FORMAT,
    version,
    packageIdentity,
    sourceCommit,
    assets,
  };
}

export function parseUpdateMirrorManifest(bytes, expected = {}) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('update mirror manifest is not valid JSON');
  }
  assertExactKeys(
    manifest,
    ['format', 'version', 'packageIdentity', 'sourceCommit', 'assets'],
    'update mirror manifest',
  );
  if (manifest.format !== UPDATE_MIRROR_MANIFEST_FORMAT) {
    throw new Error('update mirror manifest format is invalid');
  }
  assertVersion(manifest.version);
  assertPackageIdentity(manifest.packageIdentity);
  assertSourceCommit(manifest.sourceCommit);
  if (expected.version !== undefined && manifest.version !== expected.version) {
    throw new Error(
      'update mirror manifest version does not match the release',
    );
  }
  if (
    expected.packageIdentity !== undefined &&
    manifest.packageIdentity !== expected.packageIdentity
  ) {
    throw new Error(
      'update mirror manifest packageIdentity does not match the release',
    );
  }
  if (
    expected.sourceCommit !== undefined &&
    manifest.sourceCommit !== expected.sourceCommit
  ) {
    throw new Error(
      'update mirror manifest sourceCommit does not match the release',
    );
  }
  const expectedNames = updateMirrorAssetNames(manifest.version);
  if (
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== expectedNames.length
  ) {
    throw new Error(
      'update mirror manifest does not contain exactly seven assets',
    );
  }
  for (let index = 0; index < expectedNames.length; index += 1) {
    const asset = manifest.assets[index];
    assertExactKeys(
      asset,
      ['name', 'size', 'sha256'],
      'update mirror manifest asset',
    );
    if (asset.name !== expectedNames[index]) {
      throw new Error(
        'update mirror manifest asset names or order are invalid',
      );
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error(
        `update mirror manifest asset size is invalid: ${asset.name}`,
      );
    }
    if (
      typeof asset.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)
    ) {
      throw new Error(
        `update mirror manifest asset digest is invalid: ${asset.name}`,
      );
    }
  }
  if (text !== serializeUpdateMirrorManifest(manifest)) {
    throw new Error(
      'update mirror manifest is not in canonical deterministic form',
    );
  }
  return manifest;
}

export async function verifyUpdateMirrorManifest({
  manifestPath,
  assetDirectory,
  version,
  packageIdentity,
  sourceCommit,
}) {
  const manifest = parseUpdateMirrorManifest(await readFile(manifestPath), {
    version,
    packageIdentity,
    sourceCommit,
  });
  for (const asset of manifest.assets) {
    const actual = await digestRegularFile(
      path.join(assetDirectory, asset.name),
    );
    if (actual.size !== asset.size || actual.sha256 !== asset.sha256) {
      throw new Error(
        `update mirror asset does not match signed manifest: ${asset.name}`,
      );
    }
  }
  return manifest;
}

async function main() {
  const [
    command,
    firstPath,
    secondPath,
    version,
    packageIdentity,
    sourceCommit,
  ] = process.argv.slice(2);
  if (command === 'create') {
    if (
      !firstPath ||
      !secondPath ||
      !version ||
      !packageIdentity ||
      !sourceCommit
    ) {
      throw new Error(
        'usage: update-mirror-manifest.mjs create <asset-directory> <manifest> <version> <package-identity> <source-commit>',
      );
    }
    const manifest = await createUpdateMirrorManifest({
      assetDirectory: path.resolve(firstPath),
      version,
      packageIdentity,
      sourceCommit,
    });
    await writeFile(
      path.resolve(secondPath),
      serializeUpdateMirrorManifest(manifest),
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      },
    );
    return;
  }
  if (command === 'verify') {
    if (
      !firstPath ||
      !secondPath ||
      !version ||
      !packageIdentity ||
      !sourceCommit
    ) {
      throw new Error(
        'usage: update-mirror-manifest.mjs verify <manifest> <asset-directory> <version> <package-identity> <source-commit>',
      );
    }
    await verifyUpdateMirrorManifest({
      manifestPath: path.resolve(firstPath),
      assetDirectory: path.resolve(secondPath),
      version,
      packageIdentity,
      sourceCommit,
    });
    return;
  }
  throw new Error('update mirror manifest command must be create or verify');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`[update-mirror-manifest] ${error.message}\n`);
    process.exitCode = 3;
  });
}
