/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  createEncryptedFieldCipher,
  Database,
} from '../data_platform/index.js';
import type { ParkCarpoolIntent } from './parkCarpoolDomain.js';
import { PARK_CARPOOL_SCHEMA_CONTRIBUTOR } from './parkCarpoolSchema.js';
import { createParkCarpoolSqliteStore } from './parkCarpoolSqliteRepository.js';

function setup() {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      park_id TEXT
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL, deleted_at TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );
    INSERT INTO organizations VALUES
      ('org-a', '甲企业', 'active', 'park-a'),
      ('org-b', '乙企业', 'active', 'park-a');
    INSERT INTO accounts VALUES
      ('account-a', 'org-a', '张某', 'active', NULL),
      ('account-b', 'org-b', '李某', 'active', NULL);
  `);
  applyDatabaseSchemaContributors(database, [PARK_CARPOOL_SCHEMA_CONTRIBUTOR]);
  const fieldCipher = createEncryptedFieldCipher({
    keyProvider: { getKey: () => Buffer.alloc(32, 7) },
  });
  return {
    database,
    store: createParkCarpoolSqliteStore({
      db: () => database,
      fieldCipher,
      getPrincipal: (accountId) => {
        const row = database
          .prepare(
            `SELECT a.id, a.organization_id, a.name, a.status, a.deleted_at,
                  o.name AS organization_name, o.status AS organization_status,
                  o.park_id
           FROM accounts a JOIN organizations o ON o.id = a.organization_id
           WHERE a.id = ?`,
          )
          .get(accountId) as Record<string, unknown> | undefined;
        return row
          ? {
              accountId: String(row.id),
              organizationId: String(row.organization_id),
              organizationName: String(row.organization_name),
              displayName: String(row.name),
              parkId: typeof row.park_id === 'string' ? row.park_id : null,
              active:
                row.status === 'active' &&
                row.organization_status === 'active' &&
                !row.deleted_at,
              parkServiceEnabled: true,
            }
          : null;
      },
    }),
  };
}

function intent(input: Partial<ParkCarpoolIntent> = {}): ParkCarpoolIntent {
  return {
    id: 'intent-a',
    accountId: 'account-a',
    organizationId: 'org-a',
    organizationName: '甲企业',
    displayName: '张某',
    parkId: 'park-a',
    travelDate: '2026-09-02',
    origin: {
      label: '宏创园区南门',
      coordinate: { longitude: 116.23, latitude: 40.22 },
    },
    destination: {
      label: '回龙观某小区 12 号楼',
      coordinate: { longitude: 116.31, latitude: 40.17 },
    },
    departureTime: '2026-09-02T10:30:00.000Z',
    flexibleMinutes: 30,
    travelOptions: ['rider'],
    route: {
      provider: 'amap',
      distanceMeters: 12_000,
      durationSeconds: 1_800,
      polyline: [
        { longitude: 116.23, latitude: 40.22 },
        { longitude: 116.31, latitude: 40.17 },
      ],
    },
    status: 'active',
    lastConfirmedAt: '2026-09-02T09:00:00.000Z',
    expiresAt: '2026-09-02T11:00:00.000Z',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    ...input,
  };
}

describe('park carpool SQLite store', () => {
  it('encrypts exact locations/routes, upserts one daily intent, and decrypts for matching', async () => {
    const { database, store } = setup();
    try {
      await store.saveIntent(intent());
      await store.saveIntent(intent({ flexibleMinutes: 15 }));
      const raw = database
        .prepare(
          'SELECT sensitive_ciphertext, travel_options FROM park_carpool_intents',
        )
        .get() as { sensitive_ciphertext: string; travel_options: string };
      expect(JSON.stringify(raw)).not.toContain('回龙观');
      expect(JSON.stringify(raw)).not.toContain('116.31');
      expect(raw.travel_options).toBe('["rider"]');
      expect(
        database
          .prepare('SELECT count(*) AS count FROM park_carpool_intents')
          .get(),
      ).toEqual({ count: 1 });
      await expect(
        store.getIntent('account-a', '2026-09-02'),
      ).resolves.toMatchObject({
        id: 'intent-a',
        flexibleMinutes: 15,
        destination: { label: '回龙观某小区 12 号楼' },
      });
    } finally {
      database.close();
    }
  });

  it('lists only active, unexpired park/date records and enforces stop ownership', async () => {
    const { database, store } = setup();
    try {
      await store.saveIntent(intent());
      await store.saveIntent(
        intent({
          id: 'intent-b',
          accountId: 'account-b',
          organizationId: 'org-b',
          organizationName: '乙企业',
          displayName: '李某',
          travelOptions: ['driver'],
        }),
      );
      await expect(
        store.listActiveIntents('park-a', '2026-09-02'),
      ).resolves.toHaveLength(2);
      await expect(
        store.stopIntent('account-b', 'intent-a', '2026-09-02T09:10:00.000Z'),
      ).resolves.toBeNull();
      await expect(
        store.stopIntent('account-a', 'intent-a', '2026-09-02T09:10:00.000Z'),
      ).resolves.toMatchObject({ status: 'paused' });
      await expect(
        store.listActiveIntents('park-a', '2026-09-02'),
      ).resolves.toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

describe('atomic carpool versions', () => {
  it('rejects stale writes after stop, including identical clock timestamps', async () => {
    const { database, store } = setup();
    try {
      const saved = await store.saveIntent(intent(), null);
      await store.stopIntent(saved.accountId, saved.id, saved.updatedAt);
      await expect(
        store.saveIntent({ ...saved, status: 'active' }, saved.version ?? 1),
      ).rejects.toThrow(/更新/);
      expect((await store.getIntent(saved.accountId))?.status).toBe('paused');
    } finally {
      database.close();
    }
  });
  it('allows exactly one concurrent creation and one update per version', async () => {
    const { database, store } = setup();
    try {
      const created = await Promise.allSettled([
        store.saveIntent(intent(), null),
        store.saveIntent(intent(), null),
      ]);
      expect(created.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const current = (await store.getIntent('account-a'))!;
      const changed = await Promise.allSettled([
        store.saveIntent({ ...current, flexibleMinutes: 10 }, current.version),
        store.saveIntent({ ...current, flexibleMinutes: 20 }, current.version),
      ]);
      expect(changed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

it('paginates before decoding and isolates a corrupt candidate', async () => {
  const { database, store } = setup();
  try {
    await store.saveIntent(intent());
    await store.saveIntent(
      intent({
        id: 'intent-b',
        accountId: 'account-b',
        organizationId: 'org-b',
      }),
    );
    database
      .prepare(
        "UPDATE park_carpool_intents SET sensitive_auth_tag = 'broken' WHERE id = 'intent-a'",
      )
      .run();
    const first = await store.listIntentPage!(
      'park-a',
      '2026-09-02',
      undefined,
      1,
    );
    expect(first.intents).toEqual([]);
    expect(first.failedCount).toBe(1);
    expect(first.nextCursor).toBe('intent-a');
    const second = await store.listIntentPage!(
      'park-a',
      '2026-09-02',
      first.nextCursor!,
      1,
    );
    expect(second.intents[0]?.id).toBe('intent-b');
  } finally {
    database.close();
  }
});
