/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedFieldValue,
} from '../data_platform/index.js';
import type {
  PostgresPoolLike,
} from '../data_platform/postgresDatabaseLifecycle.js';
import type { RecruitmentSearchRunRecord } from './recruitmentSourceGateway.js';

export interface RecruitmentSyncCursor {
  organizationId: string;
  sourceId: string;
  cursor: string;
  updatedAt: string;
}

export interface RecruitmentSourceStore {
  purgeExpired(limit?: number): Promise<number>;
  saveSearchRun(run: RecruitmentSearchRunRecord): Promise<void>;
  getSearchRun(
    organizationId: string,
    runId: string,
  ): Promise<RecruitmentSearchRunRecord | null>;
  listSearchRuns(
    organizationId: string,
    requisitionId: string,
    limit: number,
  ): Promise<RecruitmentSearchRunRecord[]>;
  getCursor(
    organizationId: string,
    sourceId: string,
  ): Promise<RecruitmentSyncCursor | null>;
  setCursor(cursor: RecruitmentSyncCursor): Promise<void>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
export const RECRUITMENT_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const live = (value: string, now: number): boolean => Number.isFinite(Date.parse(value)) && Date.parse(value) > now - RECRUITMENT_SEARCH_CACHE_TTL_MS && Date.parse(value) <= now + 60_000;
function batchLimit(value = 500): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new Error('recruitment cache batch limit is invalid');
  return value;
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function timestamp(value: string, label: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date.toISOString();
}

function normalizedRun(run: RecruitmentSearchRunRecord): RecruitmentSearchRunRecord {
  return {
    ...structuredClone(run),
    organizationId: identifier(run.organizationId, 'organization id'),
    actorAccountId: identifier(run.actorAccountId, 'actor account id'),
    requisitionId: identifier(run.requisitionId, 'requisition id'),
    runId: identifier(run.runId, 'run id'),
    createdAt: timestamp(run.createdAt, 'created at'),
  };
}

function normalizedCursor(cursor: RecruitmentSyncCursor): RecruitmentSyncCursor {
  const value = cursor.cursor.trim();
  if (!value || value.length > 4_000) throw new Error('cursor is invalid');
  return {
    organizationId: identifier(cursor.organizationId, 'organization id'),
    sourceId: identifier(cursor.sourceId, 'source id'),
    cursor: value,
    updatedAt: timestamp(cursor.updatedAt, 'updated at'),
  };
}

function recordKey(organizationId: string, kind: 'search' | 'cursor', id: string): string {
  return `${organizationId}\0${kind}\0${id}`;
}

export class MemoryRecruitmentSourceStore implements RecruitmentSourceStore {
  private readonly searches = new Map<string, RecruitmentSearchRunRecord>();
  private readonly cursors = new Map<string, RecruitmentSyncCursor>();
  constructor(private readonly options: { now?: () => number } = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  async purgeExpired(limit = 500): Promise<number> {
    const max = batchLimit(limit); let count = 0;
    for (const [key, value] of this.searches) if (count < max && !live(value.createdAt, this.now())) { this.searches.delete(key); count++; }
    for (const [key, value] of this.cursors) if (count < max && !live(value.updatedAt, this.now())) { this.cursors.delete(key); count++; }
    return count;
  }

  async saveSearchRun(rawRun: RecruitmentSearchRunRecord): Promise<void> {
    const run = normalizedRun(rawRun);
    const key = recordKey(run.organizationId, 'search', run.runId);
    if (this.searches.has(key)) throw new Error('recruitment search run already exists');
    this.searches.set(key, structuredClone(run));
  }

  async getSearchRun(
    organizationId: string,
    runId: string,
  ): Promise<RecruitmentSearchRunRecord | null> {
    const key = recordKey(
      identifier(organizationId, 'organization id'),
      'search',
      identifier(runId, 'run id'),
    );
    const run = this.searches.get(key);
    return structuredClone(run && live(run.createdAt, this.now()) ? run : null);
  }

  async listSearchRuns(
    organizationId: string,
    requisitionId: string,
    limit: number,
  ): Promise<RecruitmentSearchRunRecord[]> {
    const organization = identifier(organizationId, 'organization id');
    const requisition = identifier(requisitionId, 'requisition id');
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    return [...this.searches.values()]
      .filter(
        (run) =>
          run.organizationId === organization && run.requisitionId === requisition && live(run.createdAt, this.now()),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedLimit)
      .map((run) => structuredClone(run));
  }

  async getCursor(
    organizationId: string,
    sourceId: string,
  ): Promise<RecruitmentSyncCursor | null> {
    const key = recordKey(
      identifier(organizationId, 'organization id'),
      'cursor',
      identifier(sourceId, 'source id'),
    );
    const cursor = this.cursors.get(key);
    return structuredClone(cursor && live(cursor.updatedAt, this.now()) ? cursor : null);
  }

  async setCursor(rawCursor: RecruitmentSyncCursor): Promise<void> {
    const cursor = normalizedCursor(rawCursor);
    this.cursors.set(
      recordKey(cursor.organizationId, 'cursor', cursor.sourceId),
      structuredClone(cursor),
    );
  }
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS enterprise_recruitment_records_v1 (
  organization_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  requisition_id TEXT,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, record_kind, record_id)
);
CREATE INDEX IF NOT EXISTS idx_enterprise_recruitment_runs_v1
ON enterprise_recruitment_records_v1(organization_id, record_kind, requisition_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_enterprise_recruitment_cache_expiry_v1 ON enterprise_recruitment_records_v1(updated_at);
`;

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS enterprise_recruitment_records_v1 (
  organization_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  requisition_id TEXT,
  payload TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, record_kind, record_id)
);
CREATE INDEX IF NOT EXISTS idx_enterprise_recruitment_runs_v1
ON enterprise_recruitment_records_v1(organization_id, record_kind, requisition_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_enterprise_recruitment_cache_expiry_v1 ON enterprise_recruitment_records_v1(updated_at);
`;

function context(organizationId: string, kind: string, id: string): string {
  return `enterprise-recruitment-v1:${organizationId}:${kind}:${id}`;
}

function encode(
  cipher: EncryptedFieldCipher,
  organizationId: string,
  kind: string,
  id: string,
  value: unknown,
): string {
  return JSON.stringify(
    cipher.encryptText(JSON.stringify(value), context(organizationId, kind, id)),
  );
}

function decode<T>(
  cipher: EncryptedFieldCipher,
  organizationId: string,
  kind: string,
  id: string,
  payload?: string,
): T | null {
  if (!payload) return null;
  return JSON.parse(
    cipher.decryptText(
      JSON.parse(payload) as EncryptedFieldValue,
      context(organizationId, kind, id),
    ),
  ) as T;
}

export function createSqliteRecruitmentSourceStore(
  db: () => Database,
  cipher: EncryptedFieldCipher,
  options: { now?: () => number } = {},
): RecruitmentSourceStore {
  const now = () => options.now?.() ?? Date.now();
  const cutoff = () => new Date(now() - RECRUITMENT_SEARCH_CACHE_TTL_MS).toISOString();
  const ready = (): Database => {
    const database = db();
    database.exec(SQLITE_SCHEMA);
    return database;
  };
  return {
    async purgeExpired(limit = 500) {
      return Number(ready().prepare(`DELETE FROM enterprise_recruitment_records_v1 WHERE rowid IN (
        SELECT rowid FROM enterprise_recruitment_records_v1 WHERE updated_at<=? ORDER BY updated_at LIMIT ?
      )`).run(cutoff(), batchLimit(limit)).changes);
    },
    async saveSearchRun(rawRun) {
      const run = normalizedRun(rawRun);
      const inserted = ready()
        .prepare(
          `INSERT INTO enterprise_recruitment_records_v1
          (organization_id,record_kind,record_id,requisition_id,payload,updated_at)
          SELECT ?,?,?,?,?,? FROM accounts WHERE id=? AND organization_id=? AND status='active' AND deleted_at IS NULL`,
        )
        .run(
          run.organizationId,
          'search',
          run.runId,
          run.requisitionId,
          encode(cipher, run.organizationId, 'search', run.runId, run),
          run.createdAt,
          run.actorAccountId,
          run.organizationId,
        );
      if (Number(inserted.changes) !== 1) throw new Error('招聘账号已注销、停用或不属于当前企业，未保存搜索缓存');
    },
    async getSearchRun(organizationId, runId) {
      const organization = identifier(organizationId, 'organization id');
      const id = identifier(runId, 'run id');
      const row = ready()
        .prepare(
          `SELECT payload FROM enterprise_recruitment_records_v1
          WHERE organization_id=? AND record_kind='search' AND record_id=? AND updated_at>?`,
        )
        .get(organization, id, cutoff()) as { payload: string } | undefined;
      const run = decode<RecruitmentSearchRunRecord>(
        cipher,
        organization,
        'search',
        id,
        row?.payload,
      );
      return checkedLiveRun(run, organization, id, now());
    },
    async listSearchRuns(organizationId, requisitionId, limit) {
      const organization = identifier(organizationId, 'organization id');
      const requisition = identifier(requisitionId, 'requisition id');
      const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 200));
      const rows = ready()
        .prepare(
          `SELECT record_id,payload FROM enterprise_recruitment_records_v1
          WHERE organization_id=? AND record_kind='search' AND requisition_id=? AND updated_at>?
          ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(organization, requisition, cutoff(), boundedLimit) as Array<{
        record_id: string;
        payload: string;
      }>;
      return rows.flatMap((row) => {
        const run = checkedLiveRun(decode<RecruitmentSearchRunRecord>(cipher, organization, 'search', row.record_id, row.payload), organization, row.record_id, now());
        return run && run.requisitionId === requisition ? [run] : [];
      });
    },
    async getCursor(organizationId, sourceId) {
      const organization = identifier(organizationId, 'organization id');
      const source = identifier(sourceId, 'source id');
      const row = ready()
        .prepare(
          `SELECT payload FROM enterprise_recruitment_records_v1
          WHERE organization_id=? AND record_kind='cursor' AND record_id=? AND updated_at>?`,
        )
        .get(organization, source, cutoff()) as { payload: string } | undefined;
      const cursor = decode<RecruitmentSyncCursor>(
        cipher,
        organization,
        'cursor',
        source,
        row?.payload,
      );
      return cursor && cursor.organizationId === organization && cursor.sourceId === source && live(cursor.updatedAt, now()) ? cursor : null;
    },
    async setCursor(rawCursor) {
      const cursor = normalizedCursor(rawCursor);
      ready()
        .prepare(
          `INSERT INTO enterprise_recruitment_records_v1
          (organization_id,record_kind,record_id,requisition_id,payload,updated_at)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(organization_id,record_kind,record_id) DO UPDATE SET
          payload=excluded.payload,updated_at=excluded.updated_at`,
        )
        .run(
          cursor.organizationId,
          'cursor',
          cursor.sourceId,
          null,
          encode(cipher, cursor.organizationId, 'cursor', cursor.sourceId, cursor),
          cursor.updatedAt,
        );
    },
  };
}

function checkedLiveRun(run: RecruitmentSearchRunRecord | null, org: string, id: string, now: number): RecruitmentSearchRunRecord | null {
  if (!run) return null;
  if (run.organizationId !== org || run.runId !== id) throw new Error('recruitment cache scope mismatch');
  identifier(run.actorAccountId, 'cache owner');
  return live(run.createdAt, now) ? run : null;
}

/** Called inside the host's account deletion transaction. Scan legacy encrypted rows
 * in small pages: old caches have no plaintext owner column, and must not be discarded
 * or assigned to the wrong person during an implicit migration. Never touch shared jobs. */
export function deleteSqliteRecruitmentSearchesForAccount(database: Database, cipher: EncryptedFieldCipher | undefined, organizationId: string, actorAccountId: string): number {
  const org = identifier(organizationId, 'organization id'); const actor = identifier(actorAccountId, 'account id');
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='enterprise_recruitment_records_v1'").get()) return 0;
  let after = ''; let deleted = 0;
  for (;;) {
    const rows = database.prepare("SELECT record_id,payload FROM enterprise_recruitment_records_v1 WHERE organization_id=? AND record_kind='search' AND record_id>? ORDER BY record_id LIMIT 50").all(org, after) as Array<{ record_id: string; payload: string }>;
    if (!rows.length) return deleted;
    if (!cipher) throw new Error('recruitment cache decryption unavailable');
    for (const row of rows) {
      const run = decode<RecruitmentSearchRunRecord>(cipher, org, 'search', row.record_id, row.payload);
      if (!run || run.organizationId !== org || run.runId !== row.record_id || typeof run.actorAccountId !== 'string') throw new Error('recruitment cache scope mismatch');
      if (run.actorAccountId === actor) deleted += Number(database.prepare("DELETE FROM enterprise_recruitment_records_v1 WHERE organization_id=? AND record_kind='search' AND record_id=?").run(org, row.record_id).changes);
      after = row.record_id;
    }
  }
}

/** The caller must lock the account FOR UPDATE and pass that SAME transaction client.
 * Writers take FOR SHARE on the account, so deletion and delayed inserts serialize. */
export async function deletePostgresRecruitmentSearchesForAccount(client: Pick<PostgresPoolLike, 'query'>, cipher: EncryptedFieldCipher, organizationId: string, actorAccountId: string): Promise<number> {
  const org = identifier(organizationId, 'organization id'); const actor = identifier(actorAccountId, 'account id');
  const table = await client.query<{ present: boolean }>("SELECT to_regclass('enterprise_recruitment_records_v1') IS NOT NULL AS present");
  if (!table.rows[0]?.present) return 0;
  let after = ''; let deleted = 0;
  for (;;) {
    const rows = await client.query<{ record_id: string; payload: string }>("SELECT record_id,payload FROM enterprise_recruitment_records_v1 WHERE organization_id=$1 AND record_kind='search' AND record_id>$2 ORDER BY record_id LIMIT 50", [org, after]);
    if (!rows.rows.length) return deleted;
    for (const row of rows.rows) {
      const run = decode<RecruitmentSearchRunRecord>(cipher, org, 'search', row.record_id, row.payload);
      if (!run || run.organizationId !== org || run.runId !== row.record_id || typeof run.actorAccountId !== 'string') throw new Error('recruitment cache scope mismatch');
      if (run.actorAccountId === actor) deleted += Number((await client.query("DELETE FROM enterprise_recruitment_records_v1 WHERE organization_id=$1 AND record_kind='search' AND record_id=$2", [org, row.record_id])).rowCount ?? 0);
      after = row.record_id;
    }
  }
}

export function createPostgresRecruitmentSourceStore(
  pool: PostgresPoolLike,
  cipher: EncryptedFieldCipher,
  options: { now?: () => number } = {},
): RecruitmentSourceStore {
  const now = () => options.now?.() ?? Date.now();
  const cutoff = () => new Date(now() - RECRUITMENT_SEARCH_CACHE_TTL_MS).toISOString();
  let initialization: Promise<unknown> | undefined;
  const ready = (): Promise<unknown> =>
    (initialization ??= pool.query(POSTGRES_SCHEMA).catch((error) => {
      initialization = undefined;
      throw error;
    }));
  return {
    async purgeExpired(limit = 500) {
      const max = batchLimit(limit); await ready();
      const result = await pool.query(`DELETE FROM enterprise_recruitment_records_v1 WHERE updated_at<=$1 AND (organization_id,record_kind,record_id) IN (
        SELECT organization_id,record_kind,record_id FROM enterprise_recruitment_records_v1 WHERE updated_at<=$1 ORDER BY updated_at LIMIT $2
      )`, [cutoff(), max]);
      return Number(result.rowCount ?? 0);
    },
    async saveSearchRun(rawRun) {
      const run = normalizedRun(rawRun);
      await ready();
      const inserted = await pool.query(
        `WITH owner AS (SELECT id FROM accounts WHERE id=$6 AND organization_id=$1 AND status='active' AND deleted_at IS NULL FOR SHARE)
        INSERT INTO enterprise_recruitment_records_v1
        (organization_id,record_kind,record_id,requisition_id,payload,updated_at)
        SELECT $1,'search',$2,$3,$4,$5 FROM owner`,
        [
          run.organizationId,
          run.runId,
          run.requisitionId,
          encode(cipher, run.organizationId, 'search', run.runId, run),
          run.createdAt,
          run.actorAccountId,
        ],
      );
      if (Number(inserted.rowCount ?? 0) !== 1) throw new Error('招聘账号已注销、停用或不属于当前企业，未保存搜索缓存');
    },
    async getSearchRun(organizationId, runId) {
      const organization = identifier(organizationId, 'organization id');
      const id = identifier(runId, 'run id');
      await ready();
      const result = await pool.query<{ payload: string }>(
        `SELECT payload FROM enterprise_recruitment_records_v1
        WHERE organization_id=$1 AND record_kind='search' AND record_id=$2 AND updated_at>$3`,
        [organization, id, cutoff()],
      );
      const run = decode<RecruitmentSearchRunRecord>(
        cipher,
        organization,
        'search',
        id,
        result.rows[0]?.payload,
      );
      return checkedLiveRun(run, organization, id, now());
    },
    async listSearchRuns(organizationId, requisitionId, limit) {
      const organization = identifier(organizationId, 'organization id');
      const requisition = identifier(requisitionId, 'requisition id');
      const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 200));
      await ready();
      const result = await pool.query<{ record_id: string; payload: string }>(
        `SELECT record_id,payload FROM enterprise_recruitment_records_v1
        WHERE organization_id=$1 AND record_kind='search' AND requisition_id=$2 AND updated_at>$3
        ORDER BY updated_at DESC LIMIT $4`,
        [organization, requisition, cutoff(), boundedLimit],
      );
      return result.rows.flatMap((row) => {
        const run = checkedLiveRun(decode<RecruitmentSearchRunRecord>(cipher, organization, 'search', row.record_id, row.payload), organization, row.record_id, now());
        return run && run.requisitionId === requisition ? [run] : [];
      });
    },
    async getCursor(organizationId, sourceId) {
      const organization = identifier(organizationId, 'organization id');
      const source = identifier(sourceId, 'source id');
      await ready();
      const result = await pool.query<{ payload: string }>(
        `SELECT payload FROM enterprise_recruitment_records_v1
        WHERE organization_id=$1 AND record_kind='cursor' AND record_id=$2 AND updated_at>$3`,
        [organization, source, cutoff()],
      );
      const cursor = decode<RecruitmentSyncCursor>(
        cipher,
        organization,
        'cursor',
        source,
        result.rows[0]?.payload,
      );
      return cursor && cursor.organizationId === organization && cursor.sourceId === source && live(cursor.updatedAt, now()) ? cursor : null;
    },
    async setCursor(rawCursor) {
      const cursor = normalizedCursor(rawCursor);
      await ready();
      await pool.query(
        `INSERT INTO enterprise_recruitment_records_v1
        (organization_id,record_kind,record_id,requisition_id,payload,updated_at)
        VALUES($1,'cursor',$2,NULL,$3,$4)
        ON CONFLICT(organization_id,record_kind,record_id) DO UPDATE SET
        payload=excluded.payload,updated_at=excluded.updated_at`,
        [
          cursor.organizationId,
          cursor.sourceId,
          encode(cipher, cursor.organizationId, 'cursor', cursor.sourceId, cursor),
          cursor.updatedAt,
        ],
      );
    },
  };
}
