/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileRpaArtifactStore } from './file-artifact-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileRpaArtifactStore', () => {
  it('stores a content-hashed artifact and only returns a redacted summary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-rpa-artifact-'));
    roots.push(root);
    const store = new FileRpaArtifactStore(root);

    const artifact = await store.put({
      mediaType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      redactedSummary: 'screenshot\nwith sensitive page text removed',
    });

    expect(artifact).toMatchObject({ mediaType: 'image/png', redactedSummary: 'screenshot with sensitive page text removed' });
    expect(artifact.sha256).toHaveLength(64);
    expect(await readdir(root)).toEqual([`${artifact.id}.png`]);
  });

  it('rejects an oversized artifact before creating a partial file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-rpa-artifact-'));
    roots.push(root);
    const store = new FileRpaArtifactStore(root, 2);

    await expect(store.put({
      mediaType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      redactedSummary: 'oversized screenshot',
    })).rejects.toThrow('exceeds 2 bytes');
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('bounds cumulative bytes without deleting referenced evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-rpa-artifact-'));
    roots.push(root);
    const store = new FileRpaArtifactStore(root, 3, { maxTotalBytes: 4, maxArtifacts: 10 });
    await store.put({ mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]), redactedSummary: 'first' });

    await expect(store.put({
      mediaType: 'image/png', bytes: new Uint8Array([4, 5]), redactedSummary: 'over total quota',
    })).rejects.toThrow('4 byte limit');
    expect(await readdir(root)).toHaveLength(1);
  });

  it('serializes concurrent writes so the file-count quota cannot race', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-rpa-artifact-'));
    roots.push(root);
    const store = new FileRpaArtifactStore(root, 2, { maxTotalBytes: 4, maxArtifacts: 1 });
    const outcomes = await Promise.allSettled([
      store.put({ mediaType: 'image/png', bytes: new Uint8Array([1]), redactedSummary: 'one' }),
      store.put({ mediaType: 'image/png', bytes: new Uint8Array([2]), redactedSummary: 'two' }),
    ]);

    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await readdir(root)).toHaveLength(1);
  });

  it('recovers after ENOSPC without a partial file or poisoned quota accounting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-rpa-artifact-'));
    roots.push(root);
    let diskFull = true;
    const write = vi.fn(async (...args: Parameters<typeof writeFile>) => {
      if (diskFull) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await writeFile(...args);
    }) as typeof writeFile;
    const store = new FileRpaArtifactStore(root, 10, {
      maxTotalBytes: 10, maxArtifacts: 1, writeFile: write,
    });

    await expect(store.put({
      mediaType: 'image/png', bytes: new Uint8Array([1]), redactedSummary: 'fails',
    })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await readdir(root)).toEqual([]);

    diskFull = false;
    await expect(store.put({
      mediaType: 'image/png', bytes: new Uint8Array([2]), redactedSummary: 'recovers',
    })).resolves.toMatchObject({ mediaType: 'image/png' });
    expect(await readdir(root)).toHaveLength(1);
  });
});
