/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  Database,
  EncryptedFieldCipher,
  EncryptedFieldValue,
} from '../data_platform/index.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
export interface PolicyPageOptions {
  after?: string;
  limit?: number;
}
export interface PolicyPage<T> {
  rows: Array<{ key: string; value: T }>;
  nextCursor?: string;
}
export interface PolicyKeyPage {
  rows: Array<{ key: string; payloadBytes: number }>;
  nextCursor?: string;
}
export const POLICY_PAGE_LIMIT = 32;
export const POLICY_BACKGROUND_RECORD_BYTES = 1024 * 1024;
export class PolicyRecordTooLargeError extends Error {
  constructor(
    readonly key: string,
    readonly payloadBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      'Policy background record exceeds byte limit; preserved history requires maintenance',
    );
  }
}
function byteLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > POLICY_BACKGROUND_RECORD_BYTES
  )
    throw new Error('Policy background byte limit must be between 1 and 1 MiB');
}
function pageBounds(prefix: string, options: PolicyPageOptions) {
  const limit = options.limit ?? POLICY_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > POLICY_PAGE_LIMIT)
    throw new Error('Policy page limit must be between 1 and 32');
  // Store prefixes are internal ASCII namespaces, not SQL LIKE patterns. The
  // primary-key range keeps a page from scanning unrelated encrypted records.
  if (!/^[\x20-\x7e]{1,256}$/u.test(prefix))
    throw new Error('Invalid policy page prefix');
  if (
    options.after !== undefined &&
    (!options.after.startsWith(prefix) || options.after.length > 1024)
  )
    throw new Error('Policy page cursor belongs to another prefix');
  return {
    limit,
    after: options.after ?? '',
    upper:
      prefix.slice(0, -1) +
      String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1),
  };
}
function pageResult<T extends { key: string }>(
  rows: T[],
  limit: number,
): { rows: T[]; nextCursor?: string } {
  return {
    rows,
    ...(rows.length === limit ? { nextCursor: rows[rows.length - 1].key } : {}),
  };
}
export interface PolicyStore {
  get<T>(key: string): Promise<T | null>;
  getBounded<T>(key: string, limitBytes: number): Promise<T | null>;
  update<T>(key: string, change: (current: T | null) => T): Promise<T>;
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  page<T>(prefix: string, options?: PolicyPageOptions): Promise<PolicyPage<T>>;
  keysPage(prefix: string, options?: PolicyPageOptions): Promise<PolicyKeyPage>;
  remove(key: string): Promise<void>;
}
export class MemoryPolicyStore implements PolicyStore {
  private readonly values = new Map<string, unknown>();
  private readonly payloadBytes = new Map<string, number>();
  async get<T>(key: string): Promise<T | null> {
    return structuredClone(this.values.get(key) ?? null) as T | null;
  }
  async getBounded<T>(key: string, limitBytes: number): Promise<T | null> {
    byteLimit(limitBytes);
    const size = this.payloadBytes.get(key) ?? 0;
    if (size > limitBytes)
      throw new PolicyRecordTooLargeError(key, size, limitBytes);
    return this.get<T>(key);
  }
  async update<T>(key: string, change: (current: T | null) => T): Promise<T> {
    const value = change(
      structuredClone(this.values.get(key) ?? null) as T | null,
    );
    const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
    this.values.set(key, structuredClone(value));
    this.payloadBytes.set(key, size);
    return structuredClone(value);
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return [...this.values]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) as T }));
  }
  async page<T>(
    prefix: string,
    options: PolicyPageOptions = {},
  ): Promise<PolicyPage<T>> {
    const page = await this.keysPage(prefix, options);
    return {
      ...page,
      rows: page.rows.map(({ key }) => ({
        key,
        value: structuredClone(this.values.get(key)) as T,
      })),
    };
  }
  async keysPage(
    prefix: string,
    options: PolicyPageOptions = {},
  ): Promise<PolicyKeyPage> {
    const { limit, after } = pageBounds(prefix, options);
    const keys: string[] = [];
    for (const key of this.values.keys()) {
      if (!key.startsWith(prefix) || key <= after) continue;
      const index = keys.findIndex((existing) => existing > key);
      if (index < 0) {
        if (keys.length < limit) keys.push(key);
      } else {
        keys.splice(index, 0, key);
        if (keys.length > limit) keys.pop();
      }
    }
    return pageResult(
      keys.map((key) => ({
        key,
        payloadBytes: this.payloadBytes.get(key) ?? 0,
      })),
      limit,
    );
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
    this.payloadBytes.delete(key);
  }
}
const SCHEMA =
  'CREATE TABLE IF NOT EXISTS enterprise_policy_records_v1 (record_key TEXT PRIMARY KEY, payload TEXT NOT NULL)';
const context = (key: string): string => `enterprise-policy-v1:${key}`;
function encode(
  cipher: EncryptedFieldCipher,
  key: string,
  value: unknown,
): string {
  return JSON.stringify(
    cipher.encryptText(JSON.stringify(value), context(key)),
  );
}
function decode<T>(
  cipher: EncryptedFieldCipher,
  key: string,
  raw?: string,
): T | null {
  return raw
    ? (JSON.parse(
        cipher.decryptText(
          JSON.parse(raw) as EncryptedFieldValue,
          context(key),
        ),
      ) as T)
    : null;
}
function decodeBounded<T>(
  cipher: EncryptedFieldCipher,
  key: string,
  row: { payload: string | null; payload_bytes: number } | undefined,
  limitBytes: number,
): T | null {
  if (!row) return null;
  const size = Number(row.payload_bytes);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error('Invalid policy record byte count');
  if (size > limitBytes)
    throw new PolicyRecordTooLargeError(key, size, limitBytes);
  if (typeof row.payload !== 'string')
    throw new Error('Policy bounded payload is unavailable');
  return decode<T>(cipher, key, row.payload);
}
export function createSqlitePolicyStore(
  db: () => Database,
  cipher: EncryptedFieldCipher,
): PolicyStore {
  const ready = (): Database => {
    const database = db();
    database.exec(SCHEMA);
    return database;
  };
  return {
    async get<T>(key: string) {
      const row = ready()
        .prepare(
          'SELECT payload FROM enterprise_policy_records_v1 WHERE record_key = ?',
        )
        .get(key) as { payload: string } | undefined;
      return decode<T>(cipher, key, row?.payload);
    },
    async getBounded<T>(key: string, limitBytes: number) {
      byteLimit(limitBytes);
      // The CASE executes inside SQLite: an oversized legacy blob never crosses
      // into JS and is not decrypted merely to discover its byte count.
      const row = ready()
        .prepare(
          'SELECT CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload END AS payload, length(CAST(payload AS BLOB)) AS payload_bytes FROM enterprise_policy_records_v1 WHERE record_key = ?',
        )
        .get(limitBytes, key) as
        { payload: string | null; payload_bytes: number } | undefined;
      return decodeBounded<T>(cipher, key, row, limitBytes);
    },
    async update<T>(key: string, change: (current: T | null) => T) {
      const database = ready();
      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database
          .prepare(
            'SELECT payload FROM enterprise_policy_records_v1 WHERE record_key = ?',
          )
          .get(key) as { payload: string } | undefined;
        const value = change(decode<T>(cipher, key, row?.payload));
        database
          .prepare(
            'INSERT INTO enterprise_policy_records_v1(record_key,payload) VALUES(?,?) ON CONFLICT(record_key) DO UPDATE SET payload=excluded.payload',
          )
          .run(key, encode(cipher, key, value));
        database.exec('COMMIT');
        return structuredClone(value);
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async list<T>(prefix: string) {
      const rows = ready()
        .prepare(
          'SELECT record_key, payload FROM enterprise_policy_records_v1 WHERE substr(record_key,1,?) = ? ORDER BY record_key',
        )
        .all(prefix.length, prefix) as Array<{
        record_key: string;
        payload: string;
      }>;
      return rows.map((row) => ({
        key: row.record_key,
        value: decode<T>(cipher, row.record_key, row.payload)!,
      }));
    },
    async page<T>(prefix: string, options: PolicyPageOptions = {}) {
      const { limit, after, upper } = pageBounds(prefix, options);
      const rows = ready()
        .prepare(
          'SELECT record_key, payload FROM enterprise_policy_records_v1 WHERE record_key >= ? AND record_key < ? AND record_key > ? AND substr(record_key,1,?) = ? ORDER BY record_key LIMIT ?',
        )
        .all(prefix, upper, after, prefix.length, prefix, limit) as Array<{
        record_key: string;
        payload: string;
      }>;
      return pageResult(
        rows.map((row) => ({
          key: row.record_key,
          value: decode<T>(cipher, row.record_key, row.payload)!,
        })),
        limit,
      );
    },
    async keysPage(prefix: string, options: PolicyPageOptions = {}) {
      const { limit, after, upper } = pageBounds(prefix, options);
      const rows = ready()
        .prepare(
          'SELECT record_key, length(CAST(payload AS BLOB)) AS payload_bytes FROM enterprise_policy_records_v1 WHERE record_key >= ? AND record_key < ? AND record_key > ? AND substr(record_key,1,?) = ? ORDER BY record_key LIMIT ?',
        )
        .all(prefix, upper, after, prefix.length, prefix, limit) as Array<{
        record_key: string;
        payload_bytes: number;
      }>;
      return pageResult(
        rows.map((row) => ({
          key: row.record_key,
          payloadBytes: Number(row.payload_bytes),
        })),
        limit,
      );
    },
    async remove(key: string) {
      ready()
        .prepare(
          'DELETE FROM enterprise_policy_records_v1 WHERE record_key = ?',
        )
        .run(key);
    },
  };
}
export function createPostgresPolicyStore(
  pool: PostgresPoolLike,
  cipher: EncryptedFieldCipher,
): PolicyStore {
  let initialization: Promise<unknown> | undefined;
  const ready = (): Promise<unknown> =>
    (initialization ??= pool.query(SCHEMA).catch((error) => {
      initialization = undefined;
      throw error;
    }));
  return {
    async get<T>(key: string) {
      await ready();
      const result = await pool.query<{ payload: string }>(
        'SELECT payload FROM enterprise_policy_records_v1 WHERE record_key=$1',
        [key],
      );
      return decode<T>(cipher, key, result.rows[0]?.payload);
    },
    async getBounded<T>(key: string, limitBytes: number) {
      byteLimit(limitBytes);
      await ready();
      const result = await pool.query<{
        payload: string | null;
        payload_bytes: number;
      }>(
        'SELECT CASE WHEN octet_length(payload) <= $2 THEN payload END AS payload, octet_length(payload) AS payload_bytes FROM enterprise_policy_records_v1 WHERE record_key=$1',
        [key, limitBytes],
      );
      return decodeBounded<T>(cipher, key, result.rows[0], limitBytes);
    },
    async update<T>(key: string, change: (current: T | null) => T) {
      await ready();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [context(key)],
        );
        const result = await client.query<{ payload: string }>(
          'SELECT payload FROM enterprise_policy_records_v1 WHERE record_key=$1 FOR UPDATE',
          [key],
        );
        const value = change(decode<T>(cipher, key, result.rows[0]?.payload));
        await client.query(
          'INSERT INTO enterprise_policy_records_v1(record_key,payload) VALUES($1,$2) ON CONFLICT(record_key) DO UPDATE SET payload=excluded.payload',
          [key, encode(cipher, key, value)],
        );
        await client.query('COMMIT');
        return structuredClone(value);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async list<T>(prefix: string) {
      await ready();
      const result = await pool.query<{ record_key: string; payload: string }>(
        'SELECT record_key,payload FROM enterprise_policy_records_v1 WHERE left(record_key,$1)=$2 ORDER BY record_key',
        [prefix.length, prefix],
      );
      return result.rows.map((row) => ({
        key: row.record_key,
        value: decode<T>(cipher, row.record_key, row.payload)!,
      }));
    },
    async page<T>(prefix: string, options: PolicyPageOptions = {}) {
      const { limit, after } = pageBounds(prefix, options);
      await ready();
      // PostgreSQL may use a locale collation. Keep its primary-key ordering for
      // both cursor and ORDER BY; an ASCII prefix upper bound is not sound there.
      const result = await pool.query<{ record_key: string; payload: string }>(
        'SELECT record_key,payload FROM enterprise_policy_records_v1 WHERE left(record_key,$1)=$2 AND record_key > $3 ORDER BY record_key LIMIT $4',
        [prefix.length, prefix, after, limit],
      );
      return pageResult(
        result.rows.map((row) => ({
          key: row.record_key,
          value: decode<T>(cipher, row.record_key, row.payload)!,
        })),
        limit,
      );
    },
    async keysPage(prefix: string, options: PolicyPageOptions = {}) {
      const { limit, after } = pageBounds(prefix, options);
      await ready();
      const result = await pool.query<{
        record_key: string;
        payload_bytes: number;
      }>(
        'SELECT record_key,octet_length(payload) AS payload_bytes FROM enterprise_policy_records_v1 WHERE left(record_key,$1)=$2 AND record_key > $3 ORDER BY record_key LIMIT $4',
        [prefix.length, prefix, after, limit],
      );
      return pageResult(
        result.rows.map((row) => ({
          key: row.record_key,
          payloadBytes: Number(row.payload_bytes),
        })),
        limit,
      );
    },
    async remove(key: string) {
      await ready();
      await pool.query(
        'DELETE FROM enterprise_policy_records_v1 WHERE record_key=$1',
        [key],
      );
    },
  };
}
