/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import sharp from 'sharp';
import { processMarketImage } from './fleaMarketImageProcessing.js';
it('decodes real JPEG pixels, auto-orients, strips EXIF and generates thumbnail', async () => {
  const source = await sharp({
    create: { width: 80, height: 40, channels: 3, background: '#ff0000' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const result = await processMarketImage(source);
  const metadata = await sharp(result.detail).metadata();
  expect(metadata).toMatchObject({ width: 40, height: 80, format: 'jpeg' });
  expect(metadata.exif).toBeUndefined();
  expect(metadata.orientation).toBeUndefined();
  expect((await sharp(result.thumbnail).metadata()).width).toBeLessThanOrEqual(
    640,
  );
});
it('rejects invalid bytes, SVG and files over 20 MB', async () => {
  for (const bytes of [
    Buffer.from('not an image'),
    Buffer.from('<svg width="10" height="10"/>'),
    Buffer.alloc(20 * 1024 * 1024 + 1),
  ])
    await expect(processMarketImage(bytes)).rejects.toThrow('INVALID_INPUT');
});

import { readFileSync } from 'node:fs';
it('decodes a real synthetic HEIC file into visible JPEG pixels', async () => {
  const source = readFileSync(
    new URL('./fixtures/synthetic.heic', import.meta.url),
  );
  const result = await processMarketImage(source);
  expect(await sharp(result.detail).metadata()).toMatchObject({
    width: 80,
    height: 40,
    format: 'jpeg',
  });
  const { data } = await sharp(result.detail)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(data[0]).toBeGreaterThan(240);
  expect(data[1]).toBeLessThan(15);
});
it.each(['png', 'webp'] as const)(
  'decodes %s and does not retain metadata',
  async (format) => {
    const bytes = await sharp({
      create: { width: 16, height: 8, channels: 3, background: '#008800' },
    })
      [format]()
      .toBuffer();
    expect(await processMarketImage(bytes)).toMatchObject({
      width: 16,
      height: 8,
    });
  },
);
