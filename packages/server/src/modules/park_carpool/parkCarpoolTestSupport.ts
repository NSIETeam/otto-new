/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  Database,
  createEncryptedFieldCipher,
} from '../data_platform/index.js';
import { createPostgresDatabaseLifecycle } from '../data_platform/postgresDatabaseLifecycle.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from '../../enterprise/postgresMigrations.js';
import { createPostgresEnterpriseBusinessRepository } from '../../enterprise/postgresBusinessRepository.js';
import { createParkCarpoolSqliteStore } from './parkCarpoolSqliteRepository.js';
import { createParkCarpoolPostgresStore } from './parkCarpoolPostgresRepository.js';
import { PARK_CARPOOL_SCHEMA_CONTRIBUTOR } from './parkCarpoolSchema.js';
import { type ParkCarpoolPrincipal } from './parkCarpoolService.js';

const keyProvider = {
  getKey: () => Buffer.alloc(32, 19),
  clear: () => undefined,
};
export const fixed = new Date('2026-09-08T00:00:00Z');
export const publish = {
  requestKey: 'request-contract-1',
  travelDate: '2026-09-08',
  origin: {
    label: '测试园区南门',
    coordinate: { longitude: 116, latitude: 40 },
  },
  destination: {
    label: '测试小区十二号楼三单元二〇一室',
    coordinate: { longitude: 116.1, latitude: 40 },
  },
  departureTime: '2026-09-08T18:30:00+08:00',
  flexibleMinutes: 30,
  travelOptions: ['shared_taxi'] as const,
};
const seed = `INSERT INTO organizations (id,name,slug,park_id) VALUES ('org-a','测试企业甲','test-a','park-a'),('org-b','测试企业乙','test-b','park-a');
INSERT INTO accounts (id,organization_id,username,password_hash,name) VALUES ('a','org-a','a','not-a-real-password','测试甲'),('b','org-b','b','not-a-real-password','测试乙'),('c','org-b','c','not-a-real-password','测试丙'),('d','org-b','d','not-a-real-password','测试丁');`;
function principal(
  row: Record<string, unknown> | undefined,
): ParkCarpoolPrincipal | null {
  return row
    ? {
        accountId: String(row.id),
        organizationId: String(row.organization_id),
        organizationName: String(row.org_name),
        displayName: String(row.name),
        parkId: String(row.park_id),
        active: row.status === 'active' && row.org_status === 'active',
        parkServiceEnabled: true,
        parkAdmin: row.id === 'a',
      }
    : null;
}
const principalQuery = `SELECT a.*, o.name AS org_name, o.status AS org_status, o.park_id FROM accounts a JOIN organizations o ON o.id=a.organization_id WHERE a.id = `;
export async function sqliteHarness() {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT,slug TEXT,park_id TEXT,status TEXT DEFAULT 'active');
CREATE TABLE accounts(id TEXT PRIMARY KEY,organization_id TEXT,username TEXT,password_hash TEXT,name TEXT,status TEXT DEFAULT 'active'); ${seed}`);
  PARK_CARPOOL_SCHEMA_CONTRIBUTOR.apply(db);
  const store = createParkCarpoolSqliteStore({
    db: () => db,
    fieldCipher: createEncryptedFieldCipher({ keyProvider }),
    getPrincipal: (id) =>
      principal(
        db.prepare(principalQuery + '?').get(id) as
          Record<string, unknown> | undefined,
      ),
  });
  return {
    store,
    seedAccounts: async (ids: string[]) => {
      const statement = db.prepare(
        "INSERT INTO accounts(id,organization_id,username,password_hash,name) VALUES (?,'org-b',?,'test-fixture',?)",
      );
      for (const id of ids) statement.run(id, id, id);
    },
    moveToParkB: async () => {
      db.exec("UPDATE organizations SET park_id='park-b' WHERE id='org-a'");
    },
    approveDevices: async (identitySigningPublicKey?: string) => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS e2ee_devices(organization_id TEXT,account_id TEXT,device_id TEXT,approval_state TEXT,revoked_at TEXT); INSERT INTO e2ee_devices VALUES ('org-a','a','device-a','approved',NULL),('org-b','b','device-b','approved',NULL),('org-b','c','device-c','approved',NULL);",
      );
      if (identitySigningPublicKey) {
        db.exec(
          'ALTER TABLE e2ee_devices ADD COLUMN identity_signing_public_key TEXT',
        );
        db.prepare('UPDATE e2ee_devices SET identity_signing_public_key=?').run(
          identitySigningPublicKey,
        );
      }
    },
    corruptIntent: async () => {
      db.exec(
        "UPDATE park_carpool_intents SET sensitive_auth_tag='corrupt' WHERE account_id='b'",
      );
    },
    workflowCipher: async () =>
      (
        db
          .prepare('SELECT encrypted_payload FROM park_carpool_workflow')
          .get() as { encrypted_payload: string }
      ).encrypted_payload,
    failReceipts: async () => {
      db.exec(
        "CREATE TRIGGER reject_receipt BEFORE UPDATE ON park_carpool_publications WHEN NEW.version > 1 BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;",
      );
    },
    disable: async () => {
      db.exec("UPDATE accounts SET status='disabled' WHERE id='a'");
    },
    close: async () => db.close(),
  };
}
export async function postgresHarness(poolSize = 10) {
  const binaryDirectory =
    process.env.OTTO_CARPOOL_POSTGRES_BIN ??
    '/opt/homebrew/opt/postgresql@17/bin';
  const directory = mkdtempSync(join(tmpdir(), 'otto-carpool-pg-'));
  let started = false;
  let pool: pg.Pool | undefined;
  const close = async () => {
    await pool?.end();
    if (started)
      execFileSync(
        join(binaryDirectory, 'pg_ctl'),
        ['-D', directory, '-m', 'fast', '-w', 'stop'],
        { stdio: 'pipe' },
      );
    rmSync(directory, { recursive: true });
  };
  try {
    execFileSync(
      join(binaryDirectory, 'initdb'),
      [
        '-D',
        directory,
        '-U',
        'carpool_test',
        '-A',
        'trust',
        '--no-locale',
        '--encoding=UTF8',
      ],
      { stdio: 'pipe' },
    );
    execFileSync(
      join(binaryDirectory, 'pg_ctl'),
      [
        '-D',
        directory,
        '-l',
        join(directory, 'test.log'),
        '-o',
        `-k ${directory} -p 55489 -c listen_addresses=''`,
        '-w',
        'start',
      ],
      { stdio: 'pipe' },
    );
    started = true;
    pool = new pg.Pool({
      max: poolSize,
      connectionTimeoutMillis: 1000,
      host: directory,
      port: 55489,
      user: 'carpool_test',
      database: 'postgres',
    });
    const sql = pool;
    await createPostgresDatabaseLifecycle({
      pool: sql,
      migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
    }).initialize();
    await sql.query(seed);
    await sql.query("UPDATE accounts SET is_admin=true WHERE id='a'");
    await sql.query(`INSERT INTO organization_features(organization_id,park_services) VALUES ('org-a',true),('org-b',true) ON CONFLICT(organization_id) DO UPDATE SET park_services=true;
      INSERT INTO enterprise_business_records(organization_id,domain,resource_type,resource_id,status,payload) VALUES
      ('org-a','park','park','park-a','active','{"adminOrganizationId":"org-a"}'),
      ('org-a','park','membership','membership_org-a','active','{"parkId":"park-a","adminOrganizationId":"org-a"}'),
      ('org-b','park','membership','membership_org-b','active','{"parkId":"park-a","adminOrganizationId":"org-a"}');`);

    const repository = createPostgresEnterpriseBusinessRepository({
      pool: sql,
      accountSyncKeyProvider: keyProvider,
      now: () => fixed,
    });
    const store = createParkCarpoolPostgresStore({
      repository,
      getPrincipal: async (id) =>
        principal((await sql.query(principalQuery + '$1', [id])).rows[0]),
    });
    return {
      store,
      seedAccounts: async (ids: string[]) => {
        for (const id of ids)
          await sql.query(
            "INSERT INTO accounts(id,organization_id,username,password_hash,name) VALUES ($1,'org-b',$1,'test-fixture',$1)",
            [id],
          );
      },
      moveToParkB: async () => {
        await sql.query(
          "UPDATE organizations SET park_id='park-b' WHERE id='org-a'; UPDATE enterprise_business_records SET payload=jsonb_set(payload,'{parkId}','\"park-b\"') WHERE resource_type='membership' AND organization_id='org-a'; INSERT INTO enterprise_business_records(organization_id,domain,resource_type,resource_id,status,payload) VALUES ('org-a','park','park','park-b','active','{\"adminOrganizationId\":\"org-a\"}')",
        );
      },
      approveDevices: async (identitySigningPublicKey?: string) => {
        await sql.query(
          "INSERT INTO e2ee_devices(organization_id,account_id,device_id,device_name,identity_signing_public_key,device_exchange_public_key,key_fingerprint,approval_state) VALUES ('org-a','a','device-a','test','dGVzdA==','dGVzdA==',repeat('a',64),'approved'),('org-b','b','device-b','test','dGVzdA==','dGVzdA==',repeat('b',64),'approved'),('org-b','c','device-c','test','dGVzdA==','dGVzdA==',repeat('c',64),'approved')",
        );
        if (identitySigningPublicKey)
          await sql.query(
            'UPDATE e2ee_devices SET identity_signing_public_key=$1',
            [identitySigningPublicKey],
          );
      },
      corruptIntent: async () => {
        await sql.query(
          "UPDATE enterprise_business_records SET payload=jsonb_set(payload,'{sensitive,authTag}', '\"corrupt\"') WHERE resource_type='carpool_intent' AND owner_account_id='b'",
        );
      },
      workflowCipher: async () =>
        (await sql.query('SELECT encrypted_payload FROM park_carpool_workflow'))
          .rows[0].encrypted_payload as string,
      failReceipts: async () => {
        await sql.query(
          "CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_type='carpool_publication' AND NEW.status='complete' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_receipt BEFORE UPDATE ON enterprise_business_records FOR EACH ROW EXECUTE FUNCTION reject_receipt();",
        );
      },
      disable: async () => {
        await sql.query("UPDATE accounts SET status='disabled' WHERE id='a'");
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
