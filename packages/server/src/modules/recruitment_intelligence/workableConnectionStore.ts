/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { Database, EncryptedFieldCipher, EncryptedFieldValue } from '../data_platform/index.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
import type { WorkableMaterialCheck } from './workableAcceptance.js';

/** Catalog verified with this user's provider grant, never accepted from a client. */
export interface WorkableVerifiedTarget { account: string; shortcode: string; label: string }
export interface WorkableConnectionRecord {
  revision: number;
  grant: { id: string; accessToken: string; expiresAt: string; targets: WorkableVerifiedTarget[] } | null;
  bindings: Array<{ jobId: string; account: string; shortcode: string; revision: string }>;
  /** Encrypted with the grant. No callback secret is stored in ordinary configuration. */
  pendingOAuth?: { state: string; verifier: string; redirectUri: string; clientId?: string; phase: 'preparing' | 'waiting' | 'exchanging'; expiresAt: number };
  lastOAuthStartedAt?: number;
  materialAcceptance?: { jobId: string; bindingVersion: string; approvalFingerprint: string; report: WorkableMaterialCheck };
}
export interface WorkableConnectionStore {
  get(org: string, actor: string): Promise<WorkableConnectionRecord | null>;
  compareAndSet(org: string, actor: string, expected: number, record: WorkableConnectionRecord): Promise<boolean>;
}
const SCHEMA = `CREATE TABLE IF NOT EXISTS enterprise_workable_connections_v1 (
  organization_id TEXT NOT NULL, account_id TEXT NOT NULL, revision INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY(organization_id, account_id)
);`;
interface Row extends Record<string, unknown> { revision: number; payload: string }
function codec(cipher: EncryptedFieldCipher) {
  const aad = (org: string, actor: string) => JSON.stringify(['workable-connection-v1', org, actor]);
  return {
    encode(org: string, actor: string, record: WorkableConnectionRecord) {
      return JSON.stringify(cipher.encryptText(JSON.stringify(record), aad(org, actor)));
    },
    decode(org: string, actor: string, row?: Row): WorkableConnectionRecord | null {
      if (!row) return null;
      // Data-governance deletion clears the encrypted payload but keeps the
      // revision so an in-flight authorization callback cannot resurrect it.
      if (row.payload === '' && Number.isSafeInteger(Number(row.revision)) && Number(row.revision) > 0) return { revision: Number(row.revision), grant: null, bindings: [] };
      const data = JSON.parse(cipher.decryptText(JSON.parse(row.payload) as EncryptedFieldValue, aad(org, actor))) as WorkableConnectionRecord;
      if (data.revision !== Number(row.revision)) throw new Error('Workable encrypted record revision mismatch');
      return data;
    },
  };
}
/** Runs on the caller's account-deletion transaction and retains the CAS fence. */
export function revokeSqliteWorkableConnectionsForAccount(database: Database, organizationId: string, accountId: string): void {
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='enterprise_workable_connections_v1'").get()) {
    database.prepare("UPDATE enterprise_workable_connections_v1 SET revision=revision+1,payload='' WHERE organization_id=? AND account_id=?").run(organizationId, accountId);
  }
}

export function createSqliteWorkableConnectionStore(db: () => Database, cipher: EncryptedFieldCipher): WorkableConnectionStore {
  const c = codec(cipher);
  const ready = () => { const database = db(); database.exec(SCHEMA); return database; };
  return {
    async get(org, actor) { return c.decode(org, actor, ready().prepare('SELECT revision,payload FROM enterprise_workable_connections_v1 WHERE organization_id=? AND account_id=?').get(org, actor) as Row | undefined); },
    async compareAndSet(org, actor, expected, record) {
      if (!Number.isSafeInteger(expected) || expected < 0 || record.revision !== expected + 1) return false;
      const payload = c.encode(org, actor, record);
      const result = expected === 0
        ? ready().prepare('INSERT INTO enterprise_workable_connections_v1(organization_id,account_id,revision,payload) VALUES(?,?,?,?) ON CONFLICT(organization_id,account_id) DO NOTHING').run(org, actor, record.revision, payload)
        : ready().prepare('UPDATE enterprise_workable_connections_v1 SET revision=?,payload=? WHERE organization_id=? AND account_id=? AND revision=?').run(record.revision, payload, org, actor, expected);
      return Number(result.changes) === 1;
    },
  };
}
export function createPostgresWorkableConnectionStore(pool: PostgresPoolLike, cipher: EncryptedFieldCipher): WorkableConnectionStore {
  const c = codec(cipher);
  let initialization: Promise<unknown> | undefined;
  const ready = () => initialization ??= pool.query(SCHEMA).catch((error) => { initialization = undefined; throw error; });
  return {
    async get(org, actor) { await ready(); return c.decode(org, actor, (await pool.query<Row>('SELECT revision,payload FROM enterprise_workable_connections_v1 WHERE organization_id=$1 AND account_id=$2', [org, actor])).rows[0]); },
    async compareAndSet(org, actor, expected, record) {
      if (!Number.isSafeInteger(expected) || expected < 0 || record.revision !== expected + 1) return false;
      await ready();
      const values = [org, actor, record.revision, c.encode(org, actor, record)];
      const result = expected === 0
        ? await pool.query('INSERT INTO enterprise_workable_connections_v1(organization_id,account_id,revision,payload) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,account_id) DO NOTHING', values)
        : await pool.query('UPDATE enterprise_workable_connections_v1 SET revision=$3,payload=$4 WHERE organization_id=$1 AND account_id=$2 AND revision=$5', [...values, expected]);
      return result.rowCount === 1;
    },
  };
}
