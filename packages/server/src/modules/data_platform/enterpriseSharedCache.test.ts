/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { createRedisEnterpriseSharedCache } from './enterpriseSharedCache.js';

describe('Redis enterprise shared cache', () => {
  it('namespaces data and checks Redis health', async () => {
    const client = {
      ping: vi.fn(async () => 'PONG'),
      get: vi.fn(async () => 'value'),
      set: vi.fn(async () => 'OK' as const),
      del: vi.fn(async () => 1),
      eval: vi.fn(async () => 1),
      quit: vi.fn(async () => undefined),
    };
    const cache = createRedisEnterpriseSharedCache({
      client,
      keyPrefix: 'otto',
    });

    await expect(cache.healthCheck()).resolves.toEqual({
      ready: true,
      backend: 'redis',
    });
    await expect(cache.get('session:abc')).resolves.toBe('value');
    expect(client.get).toHaveBeenCalledWith('otto:session:abc');
  });

  it('uses atomic NX leases and owner-checked release', async () => {
    const client = {
      ping: vi.fn(async () => 'PONG'),
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK' as const),
      del: vi.fn(async () => 0),
      eval: vi.fn(async () => 1),
      quit: vi.fn(async () => undefined),
    };
    const cache = createRedisEnterpriseSharedCache({ client });

    await expect(
      cache.acquireLease('rotation', 'worker-1', 30_000),
    ).resolves.toBe(true);
    expect(client.set).toHaveBeenCalledWith('otto:rotation', 'worker-1', {
      NX: true,
      PX: 30_000,
    });

    await expect(cache.releaseLease('rotation', 'worker-1')).resolves.toBe(
      true,
    );
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringMatching(/redis\.call\('get'/),
      {
        keys: ['otto:rotation'],
        arguments: ['worker-1'],
      },
    );
  });

  it('fails health checks closed on an unexpected response', async () => {
    const cache = createRedisEnterpriseSharedCache({
      client: {
        ping: vi.fn(async () => 'LOADING'),
        get: vi.fn(async () => null),
        set: vi.fn(async () => null),
        del: vi.fn(async () => 0),
        eval: vi.fn(async () => 0),
        quit: vi.fn(async () => undefined),
      },
    });

    await expect(cache.healthCheck()).rejects.toThrow(/health.*failed/i);
  });
});

it('renews only the current owner atomically and propagates expired ownership', async () => {
 const client={ping:vi.fn(async()=> 'PONG'),get:vi.fn(async()=>null),set:vi.fn(async()=> 'OK'),del:vi.fn(async()=>0),eval:vi.fn(async()=>1),quit:vi.fn(async()=>{})};
 const cache=createRedisEnterpriseSharedCache({client});
 expect(await cache.renewLease('maintenance','owner-a',120000)).toBe(true);
 expect(client.eval).toHaveBeenCalledWith(expect.stringMatching(/get.*\n.*pexpire/s),{keys:['otto:maintenance'],arguments:['owner-a','120000']});
 client.eval.mockResolvedValueOnce(0);
 expect(await cache.renewLease('maintenance','old-owner',120000)).toBe(false);
 await expect(cache.renewLease('maintenance','owner-a',0)).rejects.toThrow(/TTL/);
 expect(client.set).not.toHaveBeenCalled();
});
