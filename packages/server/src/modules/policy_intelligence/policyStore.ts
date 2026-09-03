/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  Database,
  EncryptedFieldCipher,
  EncryptedFieldValue,
} from '../data_platform/index.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
export interface PolicyStore {
  get<T>(key: string): Promise<T | null>;
  update<T>(key: string, change: (current: T | null) => T): Promise<T>;
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  remove(key: string): Promise<void>;
}
export class MemoryPolicyStore implements PolicyStore {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return structuredClone(this.values.get(key) ?? null) as T | null;
  }
  async update<T>(key: string, change: (current: T | null) => T): Promise<T> {
    const value = change(
      structuredClone(this.values.get(key) ?? null) as T | null,
    );
    this.values.set(key, structuredClone(value));
    return structuredClone(value);
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return [...this.values]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) as T }));
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
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
    async remove(key: string) {
      await ready();
      await pool.query(
        'DELETE FROM enterprise_policy_records_v1 WHERE record_key=$1',
        [key],
      );
    },
  };
}
