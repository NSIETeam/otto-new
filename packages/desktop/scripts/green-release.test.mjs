/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGreenUpdateManifest } from './make-green-latest-json.mjs';
import { verifyGreenUpdateManifest } from './verify-green-update-manifest.mjs';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('Otto Green release contract', () => {
  it('uses a distinct app, protocol, artifact, and packaged recognition code', async () => {
    const config = await import('../electron-builder.green.cjs');
    const build = config.default;
    expect(build.appId).toBe('ai.otto.green.desktop');
    expect(build.productName).toBe('Otto Green');
    expect(build.protocols[0].schemes).toEqual(['otto-green']);
    expect(build.extraMetadata.ottoDistributionId).toBe('otto-green');
    expect(build.directories.output).toBe('release-green');
    expect(build.nsis.shortcutName).toBe('Otto Green');
    expect(build.nsis.artifactName).toBe('Otto.green-${version}.${ext}');
  });

  it('generates and verifies a server-only Green manifest', async () => {
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), 'otto-green-'));
    tempDirs.push(releaseDir);
    const version = '1.9.8';
    const fileName = `Otto.green-${version}.exe`;
    const bytes = Buffer.from('isolated-green-installer');
    await writeFile(path.join(releaseDir, fileName), bytes);

    const { manifest } = await createGreenUpdateManifest({
      releaseDir,
      version,
      notes: 'Green test',
      publishedAt: '2026-07-28T00:00:00.000Z',
    });
    expect(manifest).toMatchObject({
      distributionId: 'otto-green',
      version,
      assets: {
        'win-x64': {
          name: fileName,
          url: `https://59.110.154.44:7777/downloads/otto-green/${fileName}`,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    });
    await expect(
      verifyGreenUpdateManifest({ releaseDir, version }),
    ).resolves.toMatchObject({ version, fileName });

    const saved = JSON.parse(
      await readFile(path.join(releaseDir, 'latest.json'), 'utf8'),
    );
    expect(saved.distributionId).toBe('otto-green');
  });
});
