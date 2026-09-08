/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { imageAccessAllowed } from './fleaMarketAttachments.js';
const actor = {
  accountId: 'buyer',
  organizationId: 'E2',
  parkId: 'P',
  active: true,
  parkActive: true,
  enterpriseEnabled: true,
  marketAdminParkIds: [],
};
it('requires current same-park qualification and independent resource authorization', () => {
  expect(imageAccessAllowed(actor, 'seller', 'P', 'listing', true)).toBe(true);
  expect(imageAccessAllowed(actor, 'seller', 'Q', 'listing', true)).toBe(false);
  expect(imageAccessAllowed(actor, 'seller', 'P', 'listing', false)).toBe(
    false,
  );
  expect(imageAccessAllowed(actor, 'seller', 'P', 'draft', true)).toBe(false);
  expect(
    imageAccessAllowed(
      { ...actor, active: false },
      'buyer',
      'P',
      'draft',
      true,
    ),
  ).toBe(false);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createEncryptedObjectStore } from '../../data_platform/index.js';
import { createMarketAttachments } from './fleaMarketAttachments.js';
import { sqliteMarketHarness } from './fleaMarketTestSupport.js';
it('persists real encrypted image bytes, denies another account and cleans expired leases after grace period', async () => {
  const h = await sqliteMarketHarness();
  const directory = mkdtempSync(join(tmpdir(), 'otto-flea-market-objects-'));
  let time = 0;
  try {
    const objects = createEncryptedObjectStore({
      root: directory,
      keyProvider: { getKey: () => Buffer.alloc(32, 9), clear() {} },
    });
    const images = createMarketAttachments({
      repository: h.repository,
      objects,
      now: () => time,
      principal: async (_tx, id) => ({ ...actor, accountId: id }),
      listingReadable: async () => false,
    });
    const bytes = await sharp({
      create: { width: 10, height: 20, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const image = await images.upload('seller', 'draft-1', bytes);
    expect((await images.read('seller', image.id)).contentType).toBe(
      'image/jpeg',
    );
    await expect(images.read('buyer', image.id)).rejects.toThrow('NOT_FOUND');
    await expect(images.lease('buyer', 'stolen', [image.id])).rejects.toThrow(
      'NOT_FOUND',
    );
    time = 31 * 86400000;
    await images.cleanup();
    await expect(images.read('seller', image.id)).rejects.toThrow('NOT_FOUND');
    expect(objects.listKeys()).toHaveLength(2);
    time = 38 * 86400000;
    await images.cleanup();
    expect(objects.listKeys()).toEqual([]);
  } finally {
    await h.close();
    rmSync(directory, { recursive: true });
  }
});

it('bounds orphan collection and makes progress across repeated runs instead of scanning every stored image', async () => {
  const h = await sqliteMarketHarness();
  try {
    await h.repository.transaction(async (tx) => {
      for (let i = 0; i < 205; i++)
        await tx.run(
          "INSERT INTO park_market_images VALUES (?, 'seller','P','available',?,?,1,1,10,0,0)",
          [`old-${String(i).padStart(3, '0')}`, `object-${i}`, `thumb-${i}`],
        );
    });
    const deleted: string[] = [];
    const images = createMarketAttachments({
      repository: h.repository,
      now: () => 8 * 86400000,
      principal: async () => actor,
      listingReadable: async () => false,
      objects: {
        put: () => ({ key: 'unused' }),
        read: () => Buffer.alloc(1),
        delete: (key) => {
          deleted.push(key);
        },
      },
    });
    await images.cleanup();
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.length).toBeLessThanOrEqual(200);
    await h.restart();
    const resumed = createMarketAttachments({
      repository: h.repository,
      now: () => 8 * 86400000,
      principal: async () => actor,
      listingReadable: async () => false,
      objects: {
        put: () => ({ key: 'unused' }),
        read: () => Buffer.alloc(1),
        delete: (key) => {
          deleted.push(key);
        },
      },
    });
    for (let i = 0; i < 4; i++) await resumed.cleanup();
    expect(new Set(deleted).size).toBe(410);
    expect(
      await h.repository.read((tx) =>
        tx.all("SELECT id FROM park_market_images WHERE state='available'"),
      ),
    ).toEqual([]);
  } finally {
    await h.close();
  }
});
