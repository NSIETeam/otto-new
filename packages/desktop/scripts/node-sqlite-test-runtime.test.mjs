/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

describe('desktop jsdom native SQLite test runtime', () => {
  it('loads the actual prefix-only Node builtin without replacing jsdom or mocking SQLite', () => {
    const nativeSqlite = createRequire(import.meta.url)('node:sqlite');
    expect(DatabaseSync).toBe(nativeSqlite.DatabaseSync);
    expect(vi.isMockFunction(DatabaseSync)).toBe(false);
    expect(document.createElement('button')).toBeInstanceOf(
      window.HTMLButtonElement,
    );
    expect(navigator.userAgent).toContain('jsdom');
  });

  it('executes bound parameters and rollback against the real native engine', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(
        'CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)',
      );
      expect(
        database.prepare('SELECT sqlite_version() AS version').get(),
      ).toEqual({
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      });
      database.exec('BEGIN');
      expect(
        database
          .prepare('INSERT INTO entries (id, value) VALUES (@id, @value)')
          .run({
            id: 1,
            value: null,
          }).changes,
      ).toBe(1);
      expect(
        database.prepare('SELECT value FROM entries WHERE id = ?').get(1),
      ).toEqual({ value: null });
      database.exec('ROLLBACK');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM entries').get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
