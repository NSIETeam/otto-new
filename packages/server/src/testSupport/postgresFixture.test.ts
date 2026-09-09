/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePostgresBinaries,
  fixturePoolConfig,
  bounded,
  createPostgresFixture,
  postgresArguments,
} from './postgresFixture.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function bin(names = ['initdb', 'postgres', 'pg_ctl'], suffix = '') {
  const directory = mkdtempSync(path.join(tmpdir(), 'otto-pg-tools-test-'));
  directories.push(directory);
  for (const name of names)
    writeFileSync(path.join(directory, name + suffix), '', { mode: 0o755 });
  return directory;
}
describe('isolated PostgreSQL test fixture', () => {
  it('discovers complete PATH tools without a platform-specific Homebrew fallback', () => {
    const directory = bin();
    expect(
      resolvePostgresBinaries({
        environment: { PATH: directory },
        platform: 'linux',
      }).postgres,
    ).toBe(path.join(directory, 'postgres'));
  });
  it('honors explicit directories, including Windows executable names and spaces', () => {
    const parent = bin([], '.exe');
    const directory = path.join(parent, 'PG tools');
    mkdirSync(directory);
    for (const name of ['initdb', 'postgres', 'pg_ctl'])
      writeFileSync(path.join(directory, `${name}.exe`), '');
    expect(
      resolvePostgresBinaries({
        binaryDirectory: directory,
        environment: {},
        platform: 'win32',
      }).initdb,
    ).toBe(path.join(directory, 'initdb.exe'));
  });
  it('does not silently fall back when an explicit tool override is incomplete', () => {
    const incomplete = bin(['initdb']);
    const complete = bin();
    expect(() =>
      resolvePostgresBinaries({
        binaryDirectory: incomplete,
        environment: { PATH: complete },
        platform: 'linux',
      }),
    ).toThrow('incomplete');
  });
  it('reports missing dependencies rather than skipping or using a production URL', async () => {
    await expect(
      createPostgresFixture({
        binaryDirectory: '/definitely-missing-postgresql-test-tools',
        user: 'test_user',
        prefix: 'otto-test-',
      }),
    ).rejects.toThrow('PostgreSQL');
    expect(() =>
      resolvePostgresBinaries({
        environment: {
          PATH: '',
          OTTO_POSTGRES_URL: 'postgres://production.invalid/db',
        },
        platform: 'linux',
      }),
    ).toThrow('OTTO_TEST_POSTGRES_BIN');
  });
  it('passes directory arguments without shell quoting and binds only isolated TCP', () => {
    expect(postgresArguments('/tmp/a directory/data', 12345)).toEqual([
      '-D',
      '/tmp/a directory/data',
      '-h',
      '127.0.0.1',
      '-p',
      '12345',
      '-c',
      'unix_socket_directories=',
      '-c',
      'max_connections=20',
      '-c',
      'shared_buffers=16MB',
    ]);
    const config = fixturePoolConfig(12345, 'test_user', 'random-test-only', 4);
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 12345,
      password: 'random-test-only',
      database: 'postgres',
      ssl: false,
      options: '',
      connectionTimeoutMillis: 1000,
    });
    expect(config).not.toHaveProperty('connectionString');
  });
  it('bounds unresolved shutdown/drain work rather than claiming cleanup succeeded', async () => {
    vi.useFakeTimers();
    try {
      const promise = bounded(new Promise(() => {}), 100, 'pool drain');
      const assertion = expect(promise).rejects.toThrow('pool drain timed out');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
