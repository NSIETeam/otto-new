/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  Database,
  createEncryptedFieldCipher,
} from '../../data_platform/index.js';
import { createPostgresDatabaseLifecycle } from '../../data_platform/postgresDatabaseLifecycle.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from '../../../enterprise/postgresMigrations.js';
import {
  createMarketSqliteRepository,
  migrateMarket,
} from './fleaMarketSqliteRepository.js';
import { createMarketPostgresRepository } from './fleaMarketPostgresRepository.js';
export const testCipher = () =>
  createEncryptedFieldCipher({
    keyProvider: { getKey: () => Buffer.alloc(32, 37), clear() {} },
  });
export const testListingFields = {
  title: '办公椅',
  category: 'office',
  saleMode: 'sale',
  price: '10.01',
  condition: 'used',
  functionStatus: 'working',
  description: '可正常升降的办公椅',
  handoverArea: '园区南门',
  imageIds: ['image-1'],
};
export async function sqliteMarketHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'otto-flea-market-sqlite-'));
  const file = join(directory, 'market.db');
  let db = new Database(file);
  migrateMarket(db);
  let repository = createMarketSqliteRepository(db);
  return {
    get repository() {
      return repository;
    },
    async restart() {
      db.close();
      db = new Database(file);
      migrateMarket(db);
      repository = createMarketSqliteRepository(db);
    },
    async close() {
      db.close();
      rmSync(directory, { recursive: true });
    },
  };
}
export async function postgresMarketHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'otto-flea-market-pg-'));
  const bin =
    process.env.OTTO_FLEA_MARKET_POSTGRES_BIN ??
    '/opt/homebrew/opt/postgresql@17/bin';
  let started = false;
  let pool: pg.Pool | undefined;
  const start = () => {
    execFileSync(
      join(bin, 'pg_ctl'),
      [
        '-D',
        directory,
        '-l',
        join(directory, 'postgres.log'),
        '-o',
        `-k ${directory} -p 55491 -c listen_addresses=''`,
        '-w',
        'start',
      ],
      { stdio: 'pipe' },
    );
    started = true;
  };
  const stop = () => {
    if (started) {
      execFileSync(
        join(bin, 'pg_ctl'),
        ['-D', directory, '-m', 'fast', '-w', 'stop'],
        { stdio: 'pipe' },
      );
      started = false;
    }
  };
  const connections = new Set<pg.PoolClient>();
  const connect = () => {
    const next = new pg.Pool({
      host: directory,
      port: 55491,
      user: 'market_test',
      database: 'postgres',
      max: 4,
    });
    next.on('connect', (client) => {
      connections.add(client);
      client.once('end', () => connections.delete(client));
    });
    return next;
  };
  const drain = async () => {
    // pg-pool.end() can resolve before client sockets emit their final end.
    // Wait for those sockets before pg_ctl sends termination to the cluster.
    const ended = [...connections].map(
      (client) => new Promise<void>((resolve) => client.once('end', resolve)),
    );
    await pool?.end();
    await Promise.all(ended);
  };
  const close = async () => {
    await drain();
    stop();
    rmSync(directory, { recursive: true });
  };
  try {
    execFileSync(
      join(bin, 'initdb'),
      [
        '-D',
        directory,
        '-U',
        'market_test',
        '-A',
        'trust',
        '--no-locale',
        '--encoding=UTF8',
      ],
      { stdio: 'pipe' },
    );
    start();
    pool = connect();
    await createPostgresDatabaseLifecycle({
      pool,
      migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
    }).initialize();
    await createPostgresDatabaseLifecycle({
      pool,
      migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
    }).initialize();
    let repository = createMarketPostgresRepository(pool);
    return {
      get repository() {
        return repository;
      },
      async restart() {
        await drain();
        stop();
        start();
        pool = connect();
        repository = createMarketPostgresRepository(pool);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

import type { MarketPrincipal } from './fleaMarketTypes.js';
import type {
  MarketRepository,
  MarketTransaction,
} from './fleaMarketRepository.js';
export async function marketServiceFixture(repository: MarketRepository) {
  await repository.transaction(async (tx) => {
    await tx.run(
      'CREATE TABLE test_market_accounts(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,park_id TEXT,active INTEGER NOT NULL)',
    );
    for (const [id, org, park] of [
      ['seller', 'E1', 'P'],
      ['buyer', 'E2', 'P'],
      ['stranger', 'E2', 'P'],
      ['outsider', 'E3', 'Q'],
    ])
      await tx.run('INSERT INTO test_market_accounts VALUES (?,?,?,1)', [
        id,
        org,
        park,
      ]);
    await tx.run(
      "INSERT INTO park_market_images(id,owner_id,park_id,state,bytes,created_at) VALUES ('image-1','seller','P','available',100,0)",
    );
    await tx.run(
      "INSERT INTO park_market_image_refs VALUES ('image-1','draft','fixture','seller',?)",
      [Date.parse('2027-09-08T00:00:00Z')],
    );
  });
  return {
    repository,
    cipher: testCipher(),
    now: () => Date.parse('2026-09-08T00:00:00Z'),
    principal: async (
      tx: MarketTransaction,
      id: string,
    ): Promise<MarketPrincipal | null> => {
      const [row] = await tx.all(
        'SELECT * FROM test_market_accounts WHERE id=?',
        [id],
      );
      return row
        ? {
            accountId: id,
            organizationId: String(row.organization_id),
            parkId: row.park_id === null ? null : String(row.park_id),
            active: row.active === 1,
            parkActive: true,
            enterpriseEnabled: true,
            marketAdminParkIds: [],
          }
        : null;
    },
    config: async () => ({
      enabled: true,
      ready: true,
      timezone: 'Asia/Shanghai',
      rules: '个人闲置',
      responsibleAccountId: 'admin',
      contact: '运营',
    }),
  };
}
