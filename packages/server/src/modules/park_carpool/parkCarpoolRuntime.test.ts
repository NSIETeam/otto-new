/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core';
import { startCarpoolMaintenance } from './parkCarpoolRuntime.js';
import type { EnterpriseSharedCache } from '../data_platform/index.js';

it('registers the initial maintenance run so shutdown waits for its database work', async () => {
  vi.useFakeTimers();
  const registry = new RecurringTaskRegistry();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const work = vi.fn(async () => pending);
  const stop = startCarpoolMaintenance({ run: work, taskRegistry: registry });
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledOnce();
    let drained = false;
    const shutdown = registry.shutdown({ timeoutMs: 100 }).then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(false);
    release();
    await shutdown;
    expect(drained).toBe(true);
  } finally { release(); stop(); vi.useRealTimers(); }
});

it('does not launch a queued initial run after registry shutdown', async () => {
  vi.useFakeTimers();
  const registry = new RecurringTaskRegistry();
  const work = vi.fn(async () => undefined);
  const stop = startCarpoolMaintenance({ run: work, taskRegistry: registry });
  try {
    await registry.shutdown({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(work).not.toHaveBeenCalled();
  } finally { stop(); vi.useRealTimers(); }
});

it('rejects the drain deadline while initial work still owns the database', async () => {
  vi.useFakeTimers();
  const registry = new RecurringTaskRegistry();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const stop = startCarpoolMaintenance({ run: async () => pending, taskRegistry: registry });
  try {
    await vi.advanceTimersByTimeAsync(1);
    const shutdown = registry.shutdown({ timeoutMs: 10 }).then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await shutdown).toBeInstanceOf(Error);
  } finally { release(); stop(); await vi.advanceTimersByTimeAsync(1); vi.useRealTimers(); }
});

it('releases but never uses a lease that arrives after stop', async () => {
  vi.useFakeTimers();
  const registry = new RecurringTaskRegistry();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const work = vi.fn(async () => undefined);
  const releaseLease = vi.fn(async () => true);
  const stop = startCarpoolMaintenance({ run: work, taskRegistry: registry, cache: {
    acquireLease: async () => { await pending; return true; }, releaseLease,
  } as unknown as EnterpriseSharedCache });
  try {
    await vi.advanceTimersByTimeAsync(1);
    stop();
    const shutdown = registry.shutdown({ timeoutMs: 100 });
    release();
    await shutdown;
    expect(work).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledOnce();
  } finally { release(); stop(); vi.useRealTimers(); }
});

it('drains an in-flight lease renewal before closing cache ownership', async () => {
  vi.useFakeTimers();
  const registry = new RecurringTaskRegistry();
  let finishWork!: () => void;
  let finishRenewal!: () => void;
  const work = new Promise<void>(resolve => { finishWork = resolve; });
  const renewal = new Promise<void>(resolve => { finishRenewal = resolve; });
  const releaseLease = vi.fn(async () => true);
  const stop = startCarpoolMaintenance({ run: async () => work, taskRegistry: registry, cache: {
    acquireLease: async () => true, renewLease: async () => { await renewal; return true; }, releaseLease,
  } as unknown as EnterpriseSharedCache });
  try {
    await vi.advanceTimersByTimeAsync(40_001);
    stop();
    let drained = false;
    const shutdown = registry.shutdown({ timeoutMs: 100 }).then(() => { drained = true; });
    finishWork();
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(false);
    expect(releaseLease).not.toHaveBeenCalled();
    finishRenewal();
    await shutdown;
    expect(releaseLease).toHaveBeenCalledOnce();
  } finally { finishWork(); finishRenewal(); stop(); vi.useRealTimers(); }
});
it('continues scheduled maintenance after lease release fails', async () => {
  vi.useFakeTimers();
  let runs = 0;
  let releases = 0;
  const errors: unknown[] = [];
  const stop = startCarpoolMaintenance({
    run: async () => {
      runs++;
    },
    onError: (error) => errors.push(error),
    cache: {
      acquireLease: async () => true,
      releaseLease: async () => {
        if (++releases === 1) throw new Error('Redis connection interrupted');
      },
    } as unknown as EnterpriseSharedCache,
  });
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(2);
  } finally {
    stop();
    vi.useRealTimers();
  }
});

it('renews a long-running lease so a second worker cannot repeat effective work', async () => {
  vi.useFakeTimers();
  let owner: string | null = null;
  let until = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const work = vi.fn(async () => pending);
  const cache = {
    acquireLease: async (_key: string, next: string, ttl: number) => {
      if (owner && until > Date.now()) return false;
      owner = next; until = Date.now() + ttl; return true;
    },
    renewLease: async (_key: string, current: string, ttl: number) => {
      if (owner !== current || until <= Date.now()) return false;
      until = Date.now() + ttl; return true;
    },
    releaseLease: async (_key: string, current: string) => { if (owner !== current) return false; owner = null; return true; },
  } as unknown as EnterpriseSharedCache;
  const stopA = startCarpoolMaintenance({run:work,cache});
  const stopB = startCarpoolMaintenance({run:work,cache});
  try {
    await vi.advanceTimersByTimeAsync(180_001);
    expect(work).toHaveBeenCalledTimes(1);
  } finally { finish(); stopA();stopB();await vi.advanceTimersByTimeAsync(1);vi.useRealTimers(); }
});
it.each([false, 'throws'])('aborts outstanding work when renewal fails: %s', async failure => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const errors: unknown[] = [];
  const stop = startCarpoolMaintenance({
    run: async received => {signal=received; await new Promise<void>(resolve => received.addEventListener('abort',()=>resolve(),{once:true}));},
    cache: {acquireLease:async()=>true, renewLease:async()=>{if(failure==='throws')throw new Error('lost');return false;}, releaseLease:async()=>false} as unknown as EnterpriseSharedCache,
    onError:error=>errors.push(error),
  });
  try {await vi.advanceTimersByTimeAsync(40_001);expect(signal?.aborted).toBe(true);expect(errors.length).toBeGreaterThan(0);}
  finally {stop();vi.useRealTimers();}
});

it('does not start work from a successful lease response delivered after its TTL', async () => {
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','Date','performance']});
 let release!:()=>void;
 const delayed=new Promise<void>(resolve=>{release=resolve;});
 const work=vi.fn(async()=>{});
 const stop=startCarpoolMaintenance({run:work,onError:()=>{},cache:{acquireLease:async()=>{await delayed;return true;},renewLease:async()=>false,releaseLease:async()=>false} as unknown as EnterpriseSharedCache});
 try{await vi.advanceTimersByTimeAsync(121000);release();await vi.advanceTimersByTimeAsync(1);expect(work).not.toHaveBeenCalled();}
 finally{stop();vi.useRealTimers();}
});
