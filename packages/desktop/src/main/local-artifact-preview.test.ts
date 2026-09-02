/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildLocalArtifactPreview } from './local-artifact-preview.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) =>
      fs.promises.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('buildLocalArtifactPreview', () => {
  it('uses generated full-size slide images and sorts page numbers naturally', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'otto-presentation-preview-'),
    );
    cleanup.push(root);
    const presentation = path.join(root, '经营汇报.pptx');
    const shots = path.join(root, 'shots');
    await fs.promises.mkdir(shots);
    await fs.promises.writeFile(presentation, 'pptx');
    await fs.promises.writeFile(path.join(shots, 'slide-10.png'), 'ten');
    await fs.promises.writeFile(path.join(shots, 'slide-2.png'), 'two');
    await fs.promises.writeFile(path.join(shots, 'notes.txt'), 'ignore');

    const preview = await buildLocalArtifactPreview(presentation);

    expect(preview.ok).toBe(true);
    expect(preview.kind).toBe('slides');
    expect(preview.fileName).toBe('经营汇报.pptx');
    expect(preview.slides.map((slide) => slide.fileName)).toEqual([
      'slide-2.png',
      'slide-10.png',
    ]);
    expect(preview.slides[0]?.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from('two').toString('base64')}`,
    );
  });

  it('does not treat an arbitrary non-presentation file as an internal slide deck', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'otto-presentation-preview-'),
    );
    cleanup.push(root);
    const document = path.join(root, '说明.txt');
    await fs.promises.writeFile(document, 'text');

    const preview = await buildLocalArtifactPreview(document);

    expect(preview.ok).toBe(false);
    expect(preview.kind).toBe('unsupported');
    expect(preview.slides).toEqual([]);
  });
});
