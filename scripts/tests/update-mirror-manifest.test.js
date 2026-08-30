import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createUpdateMirrorManifest,
  parseUpdateMirrorManifest,
  serializeUpdateMirrorManifest,
  updateMirrorAssetNames,
  verifyUpdateMirrorManifest,
} from '../update-mirror-manifest.mjs';

const temporaryDirectories = [];
const version = '1.9.14';
const packageIdentity = '0123456789ab-fedcba987654';
const sourceCommit = 'a'.repeat(40);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'otto-mirror-manifest-'));
  temporaryDirectories.push(directory);
  for (const [index, name] of updateMirrorAssetNames(version).entries()) {
    writeFileSync(path.join(directory, name), `asset-${index}-${name}\n`);
  }
  return directory;
}

describe('signed update mirror manifest', () => {
  it('is deterministic and binds identity plus all seven assets including three blockmaps', async () => {
    const directory = fixture();
    const manifest = await createUpdateMirrorManifest({
      assetDirectory: directory,
      version,
      packageIdentity,
      sourceCommit,
    });
    const encoded = serializeUpdateMirrorManifest(manifest);

    expect(Object.keys(manifest)).toEqual([
      'format',
      'version',
      'packageIdentity',
      'sourceCommit',
      'assets',
    ]);
    expect(manifest.assets).toHaveLength(7);
    expect(
      manifest.assets.filter(({ name }) => name.endsWith('.blockmap')),
    ).toHaveLength(3);
    expect(manifest.assets.map(({ name }) => name)).toEqual(
      updateMirrorAssetNames(version),
    );
    for (const asset of manifest.assets) {
      const bytes = readFileSync(path.join(directory, asset.name));
      expect(asset).toEqual({
        name: asset.name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    expect(
      serializeUpdateMirrorManifest(parseUpdateMirrorManifest(encoded)),
    ).toBe(encoded);
  });

  it('rejects identity substitution, extensions, noncanonical encoding and asset tampering', async () => {
    const directory = fixture();
    const manifest = await createUpdateMirrorManifest({
      assetDirectory: directory,
      version,
      packageIdentity,
      sourceCommit,
    });
    const manifestPath = path.join(directory, 'UPDATE-MIRROR-SHA256SUMS');
    writeFileSync(manifestPath, serializeUpdateMirrorManifest(manifest));

    expect(() =>
      parseUpdateMirrorManifest(readFileSync(manifestPath), {
        version,
        packageIdentity: 'f'.repeat(12) + '-' + '0'.repeat(12),
        sourceCommit,
      }),
    ).toThrow(/packageIdentity does not match/);
    expect(() =>
      parseUpdateMirrorManifest(
        `${JSON.stringify({ ...manifest, unsignedExtension: true }, null, 2)}\n`,
      ),
    ).toThrow(/fields are not exact/);
    expect(() => parseUpdateMirrorManifest(JSON.stringify(manifest))).toThrow(
      /canonical/,
    );

    writeFileSync(
      path.join(directory, manifest.assets[3].name),
      'tampered-blockmap',
    );
    await expect(
      verifyUpdateMirrorManifest({
        manifestPath,
        assetDirectory: directory,
        version,
        packageIdentity,
        sourceCommit,
      }),
    ).rejects.toThrow(/does not match signed manifest/);
  });

  it('rejects a missing or renamed blockmap even if the remaining entries are well formed', async () => {
    const directory = fixture();
    const manifest = await createUpdateMirrorManifest({
      assetDirectory: directory,
      version,
      packageIdentity,
      sourceCommit,
    });
    manifest.assets.splice(1, 1);
    expect(() =>
      parseUpdateMirrorManifest(serializeUpdateMirrorManifest(manifest)),
    ).toThrow(/exactly seven assets/);
  });
});
