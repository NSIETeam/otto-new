import { describe, it, expect, vi } from 'vitest';
import { ModuleReadCache } from './moduleReadCache.js';

describe('module read cache', () => {
  it('shares concurrent reads and retains the last successful snapshot after a failure', async () => {
    const cache = new ModuleReadCache();
    let resolve!: (value: string[]) => void;
    const load = vi.fn(() => new Promise<string[]>(done => { resolve = done; }));
    const a = cache.read('tickets', load);
    const b = cache.read('tickets', load);
    await Promise.resolve();
    resolve(['existing ticket']);
    expect(await a).toEqual(['existing ticket']);
    expect(await b).toEqual(['existing ticket']);
    expect(load).toHaveBeenCalledOnce();
    await expect(cache.read('tickets', async () => { throw new Error('offline'); }, 0)).rejects.toThrow('offline');
    expect(cache.peek('tickets')).toEqual(['existing ticket']);
  });
  it('invalidated in-flight responses cannot overwrite newer data', async () => {
    const cache = new ModuleReadCache();
    let resolve!: (value: string) => void;
    const pending = cache.read('tickets', () => new Promise<string>(done => { resolve = done; }));
    await Promise.resolve();
    cache.invalidate('tickets');
    await cache.read('tickets', async () => 'new');
    resolve('old');
    await pending;
    expect(cache.peek('tickets')).toBe('new');
  });
  it('separate login workspaces never share snapshots', async () => {
    const first = new ModuleReadCache();
    const second = new ModuleReadCache();
    await first.read('tickets', async () => ['private']);
    expect(second.peek('tickets')).toBeUndefined();
  });
});

it('consumers can reject superseded history and revoked login responses', async () => {
  const cache = new ModuleReadCache();
  let resolve!: (value: string[]) => void;
  const old = cache.read('tickets', () => new Promise<string[]>(done => { resolve = done; }));
  await Promise.resolve();
  cache.invalidate('tickets');
  resolve(['old history']);
  const value = await old;
  expect(cache.isCurrent('tickets', value)).toBe(false);
  const current = await cache.read('tickets', async () => ['new history']);
  expect(cache.isCurrent('tickets', current)).toBe(true);
  cache.clear();
  expect(cache.isCurrent('tickets', current)).toBe(false);
  expect(cache.peek('tickets')).toBeUndefined();
});
