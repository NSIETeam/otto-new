/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localMarketAcceptance,
  createMarketReadiness,
  assertLocalMarketPostgres,
} from './fleaMarketReadiness.js';
it('requires explicit isolated local acceptance, completed probes and a live worker; never enables production with an environment toggle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'otto-market-acceptance-'));
  try {
    const env = { NODE_ENV: 'development', OTTO_MARKET_LOCAL_ACCEPTANCE: '1' };
    expect(localMarketAcceptance(root, env)).toBe(false);
    writeFileSync(
      join(root, '.otto-market-acceptance.json'),
      JSON.stringify({ purpose: 'isolated-local-acceptance', version: 1 }),
    );
    expect(localMarketAcceptance(root, env)).toBe(true);
    expect(
      localMarketAcceptance(root, { ...env, NODE_ENV: 'production' }),
    ).toBe(false);
    await expect(
      assertLocalMarketPostgres(
        { local_socket: false, data_directory: root },
        env,
      ),
    ).rejects.toThrow('isolated');
    await expect(
      assertLocalMarketPostgres(
        { local_socket: true, data_directory: root },
        env,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertLocalMarketPostgres(
        { local_socket: true, data_directory: root },
        { ...env, NODE_ENV: 'production' },
      ),
    ).rejects.toThrow('isolated');
    let fail = true;
    const readiness = createMarketReadiness({
      localAcceptance: true,
      probes: {
        database: async () => {
          if (fail) throw new Error('private detail must not leak');
        },
        objects: async () => {},
      },
    });
    expect(readiness.status().ready).toBe(false);
    readiness.worker(true);
    await readiness.initialize();
    expect(readiness.status()).toMatchObject({
      ready: false,
      blocked: ['database'],
    });
    fail = false;
    await readiness.initialize();
    expect(readiness.status().ready).toBe(true);
    readiness.worker(false);
    expect(readiness.status().ready).toBe(false);
    const production = createMarketReadiness({
      localAcceptance: false,
      probes: { database: async () => {} },
    });
    production.worker(true);
    await production.initialize();
    expect(production.status()).toMatchObject({
      ready: false,
      blocked: ['production-release'],
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});
