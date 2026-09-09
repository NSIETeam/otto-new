/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import {
  MarketDraftStore,
  renewMarketDraftLeases,
  validateMarketRequest,
  assertMarketDraftScope,
} from './park-market.js';
it('confines market requests and isolates encrypted drafts by server, organization and account', () => {
  expect(() =>
    validateMarketRequest({ path: '/../accounts', method: 'GET' }),
  ).toThrow();
  expect(() =>
    validateMarketRequest({ path: '/listings/%2e%2e', method: 'GET' }),
  ).toThrow();
  expect(() =>
    validateMarketRequest({ path: '//evil.test/', method: 'POST' }),
  ).toThrow();
  expect(validateMarketRequest({ path: '/mine', method: 'GET' }).path).toBe(
    '/mine',
  );
  const root = mkdtempSync(join(tmpdir(), 'otto-market-drafts-'));
  const key = Buffer.alloc(32, 55);
  const iv = Buffer.alloc(16, 22);
  const encrypt = (text: string) => {
    const c = createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([c.update(text), c.final()]);
  };
  const decrypt = (bytes: Buffer) => {
    const c = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([c.update(bytes), c.final()]).toString();
  };
  try {
    const store = new MarketDraftStore(root, encrypt, decrypt);
    const scope = {
      server: 'https://one.test',
      organization: 'org',
      account: 'seller',
    };
    store.save(scope, [
      { id: 'draft', title: '秘密草稿', imageIds: ['image'] },
    ]);
    expect(store.load({ ...scope, account: 'buyer' })).toEqual([]);
    expect(store.load({ ...scope, server: 'https://two.test' })).toEqual([]);
    expect(new MarketDraftStore(root, encrypt, decrypt).load(scope)).toEqual([
      { id: 'draft', title: '秘密草稿', imageIds: ['image'] },
    ]);
    expect(
      readFileSync(join(root, readdirSync(root)[0])).includes(
        Buffer.from('秘密草稿'),
      ),
    ).toBe(false);
    expect(() =>
      store.save(
        scope,
        Array.from({ length: 21 }, (_, i) => ({ id: `draft-${i}` })),
      ),
    ).toThrow();
    expect(() =>
      assertMarketDraftScope(scope, { ...scope, server: 'https://two.test' }),
    ).toThrow();
    expect(() =>
      assertMarketDraftScope(scope, { ...scope, account: 'buyer' }),
    ).toThrow();
    expect(() => assertMarketDraftScope(scope, undefined)).toThrow();
    expect(() => assertMarketDraftScope(scope, scope)).not.toThrow();
    store.save(scope, []);
    expect(store.load(scope)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});
it('renews every local draft independently and retains text when an image lease cannot be renewed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'market-lease-sync-'));
  try {
    const store = new MarketDraftStore(
      root,
      (text) => Buffer.from(text),
      (bytes) => bytes.toString(),
    );
    const scope = {
      server: 'https://test.invalid',
      organization: 'org',
      account: 'seller',
    };
    store.save(scope, [
      { id: 'old', form: { title: '保留旧草稿', imageIds: ['missing'] } },
      { id: 'valid', form: { title: '可用草稿', imageIds: ['available'] } },
    ]);
    const called: string[] = [];
    await renewMarketDraftLeases(
      store,
      scope,
      () => true,
      async (id) => {
        called.push(id);
        if (id === 'old') throw new Error('NOT_FOUND');
      },
    );
    expect(called).toEqual(['old', 'valid']);
    expect(store.load(scope)).toMatchObject([
      {
        id: 'old',
        form: { title: '保留旧草稿', imageIds: ['missing'] },
        imageLeaseFailed: true,
      },
      { id: 'valid', form: { title: '可用草稿' }, imageLeaseFailed: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
