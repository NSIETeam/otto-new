/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../sqlite-compat.js';
import { CUSTOMER_MODULE_SCHEMA_CONTRIBUTOR } from '../modules/tool_skill_platform/customerModuleSchema.js';

type DbModule = typeof import('./db.js');

interface UpgradeFixtureMetadata {
  format: string;
  sourceVersion: string;
  sourceCommit: string;
  schemaVersion: number;
  parkOrganizationId: string;
  parkAdminAccountId: string;
  parkId: string;
  tenantOrganizationId: string;
  tenantAdminAccountId: string;
  tenantAdminUsername: string;
  departmentId: string;
  positionId: string;
  employeeId: string;
  knowledgeSourceId: string;
  ticketId: string;
  dataDbSha256: string;
  syntheticDataOnly: boolean;
}

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'v1.9.13-schema23',
);
const FIXTURE_DATABASE = path.join(FIXTURE_DIRECTORY, 'data.db');
const FIXTURE_METADATA = JSON.parse(
  fs.readFileSync(
    path.join(FIXTURE_DIRECTORY, 'fixture-metadata.json'),
    'utf8',
  ),
) as UpgradeFixtureMetadata;
const TENANT_ADMIN_PASSWORD = 'V1913-Tenant-Admin-Password!';
const PRESERVED_TABLES = [
  'organizations',
  'organization_features',
  'organization_departments',
  'organization_positions',
  'employees',
  'accounts',
  'auth_sessions',
  'knowledge',
  'parks',
  'park_services',
  'park_tenant_profiles',
  'it_tickets',
  'ticket_events',
] as const;

let temporaryDirectory: string;
const previousEnterpriseDirectory = process.env.OTTO_ENTERPRISE_DIR;

function sha256(target: string): string {
  return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

function readSchemaVersion(database: Database): number {
  return Number(
    (
      database.prepare('PRAGMA user_version').get() as {
        user_version: number;
      }
    ).user_version,
  );
}

function tableCounts(database: Database): Record<string, number> {
  return Object.fromEntries(
    PRESERVED_TABLES.map((table) => [
      table,
      Number(
        (
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count,
      ),
    ]),
  );
}

function copyFixture(): string {
  const target = path.join(temporaryDirectory, 'data.db');
  fs.copyFileSync(FIXTURE_DATABASE, target);
  return target;
}

async function openCurrentDatabase(): Promise<DbModule> {
  process.env.OTTO_ENTERPRISE_DIR = temporaryDirectory;
  vi.resetModules();
  return import('./db.js');
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'otto-v1913-upgrade-'),
  );
});

afterEach(() => {
  if (previousEnterpriseDirectory === undefined) {
    delete process.env.OTTO_ENTERPRISE_DIR;
  } else {
    process.env.OTTO_ENTERPRISE_DIR = previousEnterpriseDirectory;
  }
  vi.resetModules();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('legacy schema 23/24 to V1.9.15 schema 26 acceptance', () => {
  it('locks the fixture to the real V1.9.13 source and its byte digest', () => {
    expect(FIXTURE_METADATA).toMatchObject({
      format: 'otto-enterprise-v1.9.13-schema23-fixture-v1',
      sourceVersion: '1.9.13',
      sourceCommit: '82b5e0c101a44358efbb900b0c2be62455c2412b',
      schemaVersion: 23,
      syntheticDataOnly: true,
    });
    expect(sha256(FIXTURE_DATABASE)).toBe(FIXTURE_METADATA.dataDbSha256);
    const fixture = new Database(FIXTURE_DATABASE, { readonly: true });
    try {
      expect(readSchemaVersion(fixture)).toBe(23);
      expect(
        fixture
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'customer_module_versions'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it('migrates the real schema-23 database and preserves every critical domain', async () => {
    const databasePath = copyFixture();
    const before = new Database(databasePath, { readonly: true });
    const countsBefore = tableCounts(before);
    const sessionBefore = before
      .prepare(
        `SELECT account_id, token_hash, expires_at
         FROM auth_sessions WHERE account_id = ?`,
      )
      .get(FIXTURE_METADATA.tenantAdminAccountId);
    const tenantProfileBefore = before
      .prepare(
        `SELECT organization_id, park_id, address, room_number
         FROM park_tenant_profiles WHERE organization_id = ?`,
      )
      .get(FIXTURE_METADATA.tenantOrganizationId);
    before.close();

    const db = await openCurrentDatabase();
    try {
      expect(db.getDatabaseReadiness()).toEqual({
        ready: true,
        schemaVersion: 26,
      });
      expect(
        db
          .getDB()
          .prepare('PRAGMA table_info(it_tickets)')
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual(expect.arrayContaining([
        'idempotency_key',
        'idempotency_request_hash',
      ]));
      expect(
        db
          .getDB()
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name = 'idx_it_tickets_creator_idempotency'`,
          )
          .get(),
      ).toEqual({ name: 'idx_it_tickets_creator_idempotency' });
      expect(tableCounts(db.getDB())).toEqual(countsBefore);
      expect(
        db
          .getDB()
          .prepare(
            `SELECT account_id, token_hash, expires_at
             FROM auth_sessions WHERE account_id = ?`,
          )
          .get(FIXTURE_METADATA.tenantAdminAccountId),
      ).toEqual(sessionBefore);
      expect(
        db
          .getDB()
          .prepare(
            `SELECT organization_id, park_id, address, room_number
             FROM park_tenant_profiles WHERE organization_id = ?`,
          )
          .get(FIXTURE_METADATA.tenantOrganizationId),
      ).toEqual(tenantProfileBefore);

      expect(
        db.authenticateAccount(
          FIXTURE_METADATA.tenantAdminUsername,
          TENANT_ADMIN_PASSWORD,
        ),
      ).toMatchObject({
        id: FIXTURE_METADATA.tenantAdminAccountId,
        organizationId: FIXTURE_METADATA.tenantOrganizationId,
        employeeId: FIXTURE_METADATA.employeeId,
        departmentId: FIXTURE_METADATA.departmentId,
        positionId: FIXTURE_METADATA.positionId,
        isAdmin: true,
      });
      const freshSession = db.createAuthSession(
        FIXTURE_METADATA.tenantAdminAccountId,
      );
      expect(db.getAccountBySession(freshSession.token)).toMatchObject({
        id: FIXTURE_METADATA.tenantAdminAccountId,
        organizationId: FIXTURE_METADATA.tenantOrganizationId,
      });

      expect(
        db.getOrganization(FIXTURE_METADATA.tenantOrganizationId),
      ).toMatchObject({
        id: FIXTURE_METADATA.tenantOrganizationId,
        name: 'V1.9.13 升级验收企业',
        slug: 'v1913-upgrade-tenant',
        parkId: FIXTURE_METADATA.parkId,
      });
      expect(
        db.listOrganizationStructure(FIXTURE_METADATA.tenantOrganizationId),
      ).toEqual([
        expect.objectContaining({
          id: FIXTURE_METADATA.departmentId,
          name: '产品研发中心',
          positions: [
            expect.objectContaining({
              id: FIXTURE_METADATA.positionId,
              title: '研发负责人',
              roleMapping: 'enterprise_admin',
            }),
          ],
        }),
      ]);
      expect(
        db.getConfiguredOrganizationFeatures(
          FIXTURE_METADATA.tenantOrganizationId,
        ),
      ).toMatchObject({ direct_messages: false, feishu_auto_reply: false });

      expect(
        db
          .getKnowledge(
            undefined,
            undefined,
            FIXTURE_METADATA.tenantOrganizationId,
          )
          .find(
            (entry) => entry.source_id === FIXTURE_METADATA.knowledgeSourceId,
          ),
      ).toMatchObject({
        title: 'V1.9.13 企业长期知识',
        content: '客户交付前必须执行双人复核并保留验收证据。',
        confidence: 0.95,
      });

      expect(
        db.getParkForOrganization(FIXTURE_METADATA.tenantOrganizationId),
      ).toMatchObject({
        id: FIXTURE_METADATA.parkId,
        name: 'V1.9.13 宏创科技园',
        brandName: '宏创园区服务',
      });
      expect(
        db.getTicketForAccount(
          FIXTURE_METADATA.ticketId,
          FIXTURE_METADATA.tenantAdminAccountId,
        ),
      ).toMatchObject({
        id: FIXTURE_METADATA.ticketId,
        title: 'V1.9.13 历史停车申请',
        serviceId: 'parking',
        history: [expect.objectContaining({ action: 'created' })],
      });

      expect(
        db.getEnterprisePublicProfile(
          FIXTURE_METADATA.tenantOrganizationId,
        ),
      ).toMatchObject({
        organizationId: FIXTURE_METADATA.tenantOrganizationId,
        organizationName: 'V1.9.13 升级验收企业',
        isPublic: false,
      });
      expect(
        db.updateEnterprisePublicProfile({
          organizationId: FIXTURE_METADATA.tenantOrganizationId,
          actorAccountId: FIXTURE_METADATA.tenantAdminAccountId,
          summary: '由 V1.9.13 安全升级而来的企业资料',
          website: 'https://example.invalid/v1913-upgrade',
          industryTags: ['企业服务'],
          productsServices: ['协同办公'],
          capabilities: ['园区数字化'],
          cooperationNeeds: ['联合交付'],
          publicContact: '仅用于升级验收',
          isPublic: true,
        }),
      ).toMatchObject({
        organizationId: FIXTURE_METADATA.tenantOrganizationId,
        summary: '由 V1.9.13 安全升级而来的企业资料',
        isPublic: true,
      });
      expect(
        db
          .getDB()
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'customer_module_versions'`,
          )
          .get(),
      ).toEqual({ name: 'customer_module_versions' });
    } finally {
      db.closeEnterpriseDatabase();
    }
  }, 60_000);

  it('migrates a synthetic schema-24 database without losing tenant, session or module records', async () => {
    // This is a synthetic schema-24 regression, not a copy of the production
    // database. The real schema-24 SQLCipher snapshot still needs its canary.
    const databasePath = copyFixture();
    const legacy = new Database(databasePath);
    CUSTOMER_MODULE_SCHEMA_CONTRIBUTOR.apply(legacy);
    legacy.exec(`
      INSERT INTO customer_module_versions
        (module_id, version, publisher_id, status, manifest_json, created_at, updated_at)
      VALUES ('legacy-private-module', '1.0.0', 'legacy-publisher', 'approved',
              '{"fixture":true}', '2026-08-01', '2026-08-01');
      PRAGMA user_version = 24;
    `);
    const counts = tableCounts(legacy);
    const oldSession = legacy.prepare('SELECT * FROM auth_sessions WHERE account_id = ?')
      .get(FIXTURE_METADATA.tenantAdminAccountId);
    const oldModule = legacy.prepare('SELECT * FROM customer_module_versions WHERE module_id = ?')
      .get('legacy-private-module');
    expect(readSchemaVersion(legacy)).toBe(24);
    legacy.close();

    const db = await openCurrentDatabase();
    try {
      expect(db.getDatabaseReadiness()).toEqual({ ready: true, schemaVersion: 26 });
      expect(tableCounts(db.getDB())).toEqual(counts);
      expect(db.getDB().prepare('SELECT * FROM auth_sessions WHERE account_id = ?')
        .get(FIXTURE_METADATA.tenantAdminAccountId)).toEqual(oldSession);
      expect(db.getDB().prepare('SELECT * FROM customer_module_versions WHERE module_id = ?')
        .get('legacy-private-module')).toEqual(oldModule);
      expect(db.getDB().prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      expect(db.getDB().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.getDB().prepare('PRAGMA table_info(it_tickets)').all()
        .map((column) => (column as { name: string }).name)).toEqual(
        expect.arrayContaining(['idempotency_key', 'idempotency_request_hash']),
      );
      expect(db.getDB().prepare("SELECT name FROM sqlite_master WHERE name = 'park_carpool_intents'").get())
        .toEqual({ name: 'park_carpool_intents' });
      expect(db.authenticateAccount(FIXTURE_METADATA.tenantAdminUsername, TENANT_ADMIN_PASSWORD))
        .toMatchObject({ id: FIXTURE_METADATA.tenantAdminAccountId, organizationId: FIXTURE_METADATA.tenantOrganizationId });
    } finally {
      db.closeEnterpriseDatabase();
    }
  }, 60_000);

  it('fails closed on a future schema without rewriting data or creating schema-26 tables', async () => {
    const databasePath = copyFixture();
    const future = new Database(databasePath);
    future.exec('PRAGMA user_version = 27;');
    const protectedOrganization = future
      .prepare('SELECT id, name, slug FROM organizations WHERE id = ?')
      .get(FIXTURE_METADATA.tenantOrganizationId);
    const protectedSession = future
      .prepare('SELECT account_id, token_hash FROM auth_sessions WHERE account_id = ?')
      .get(FIXTURE_METADATA.tenantAdminAccountId);
    future.close();

    const db = await openCurrentDatabase();
    expect(() => db.getDB()).toThrow(
      /schema version 27.*current version 26.*refusing downgrade/i,
    );

    const unchanged = new Database(databasePath, { readonly: true });
    try {
      expect(readSchemaVersion(unchanged)).toBe(27);
      expect(
        unchanged
          .prepare('SELECT id, name, slug FROM organizations WHERE id = ?')
          .get(FIXTURE_METADATA.tenantOrganizationId),
      ).toEqual(protectedOrganization);
      expect(
        unchanged
          .prepare(
            'SELECT account_id, token_hash FROM auth_sessions WHERE account_id = ?',
          )
          .get(FIXTURE_METADATA.tenantAdminAccountId),
      ).toEqual(protectedSession);
      expect(
        unchanged
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'customer_module_versions'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      unchanged.close();
      db.closeEnterpriseDatabase();
    }
  });

  it('keeps the live schema-23 database byte-identical when isolated migration fails', async () => {
    const liveDatabase = copyFixture();
    const liveDigest = sha256(liveDatabase);
    const candidateDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-v1913-failed-candidate-'),
    );
    const candidateDatabase = path.join(candidateDirectory, 'data.db');
    fs.copyFileSync(liveDatabase, candidateDatabase);
    const candidate = new Database(candidateDatabase);
    candidate.exec('PRAGMA user_version = 27;');
    candidate.close();

    process.env.OTTO_ENTERPRISE_DIR = candidateDirectory;
    vi.resetModules();
    const candidateRuntime: DbModule = await import('./db.js');
    try {
      expect(() => candidateRuntime.getDB()).toThrow(/refusing downgrade/i);
      expect(sha256(liveDatabase)).toBe(liveDigest);
      const live = new Database(liveDatabase, { readonly: true });
      try {
        expect(readSchemaVersion(live)).toBe(23);
        expect(
          live
            .prepare('SELECT name FROM organizations WHERE id = ?')
            .get(FIXTURE_METADATA.tenantOrganizationId),
        ).toEqual({ name: 'V1.9.13 升级验收企业' });
      } finally {
        live.close();
      }
    } finally {
      candidateRuntime.closeEnterpriseDatabase();
      fs.rmSync(candidateDirectory, { recursive: true, force: true });
    }
  });
});
