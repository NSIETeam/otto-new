/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
// Simulated process/SQL boundaries; real PostgreSQL storage assertions stay in
// the market/carpool suites and must run against installed tools in CI.
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  directory: '',
  port: '',
  child: undefined as unknown as EventEmitter & { pid: number },
  stopFails: false,
  partialPid: false,
  emptyPid: false,
  wrongDirectory: false,
  occupiedAttempts: 0,
  calls: [] as string[][],
  spawnCount: 0,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ) => {
        state.calls.push([path.basename(file), ...args]);
        if (path.basename(file).startsWith('initdb')) {
          mkdirSync(args[1]);
          callback(null, '', '');
        } else if (state.stopFails)
          callback(new Error('simulated stop timeout'));
        else {
          rmSync(path.join(state.directory, 'postmaster.pid'));
          state.child.emit('exit', 0);
          callback(null, '', '');
        }
      },
    ),
    spawn: vi.fn((_file: string, args: string[]) => {
      state.spawnCount++;
      state.directory = args[1];
      state.port = args[5];
      const child = Object.assign(new EventEmitter(), {
        pid: 12300 + state.spawnCount,
        unref: vi.fn(),
      });
      state.child = child;
      if (state.occupiedAttempts > 0) {
        state.occupiedAttempts--;
        setTimeout(() => child.emit('exit', 1), 0);
        return child;
      }
      const pid = path.join(state.directory, 'postmaster.pid');
      const complete = `${child.pid}\n${state.directory}\n0\n${state.port}\n\n127.0.0.1\n0\nready\n`;
      writeFileSync(
        pid,
        state.emptyPid
          ? ''
          : state.partialPid
            ? `${child.pid}\n${state.directory}\n`
            : complete,
      );
      if (state.partialPid) {
        const timer = setTimeout(() => writeFileSync(pid, complete), 20);
        child.once('exit', () => clearTimeout(timer));
      }
      return child;
    }),
  };
});
vi.mock('pg', () => ({
  default: {
    Pool: class extends EventEmitter {
      query() {
        return Promise.resolve({
          rows: [
            {
              directory: state.wrongDirectory
                ? '/foreign-database'
                : state.directory,
            },
          ],
        });
      }
      end() {
        return Promise.resolve();
      }
    },
  },
}));
import { createPostgresFixture } from './postgresFixture.js';
const bins: string[] = [];
afterEach(() => {
  for (const bin of bins.splice(0))
    rmSync(bin, { recursive: true, force: true });
  state.stopFails = false;
  state.partialPid = false;
  state.emptyPid = false;
  state.wrongDirectory = false;
  state.occupiedAttempts = 0;
  state.spawnCount = 0;
  state.calls = [];
});
function options() {
  const bin = mkdtempSync(path.join(tmpdir(), 'otto-pg-fake-binaries-'));
  bins.push(bin);
  for (const name of ['initdb', 'postgres', 'pg_ctl'])
    writeFileSync(
      path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')),
      '',
      { mode: 0o755 },
    );
  return {
    binaryDirectory: bin,
    user: 'fixture_user',
    prefix: 'otto-pg-lifecycle-',
  };
}
describe('PostgreSQL fixture ownership and lifecycle', () => {
  it('does not turn an already-crashed owned process into a successful close', async () => {
    const fixture = await createPostgresFixture(options());
    rmSync(path.join(fixture.directory, 'data/postmaster.pid'));
    state.child.emit('exit', 7);
    try {
      await expect(fixture.close()).rejects.toThrow('did not exit cleanly');
    } finally {
      if (existsSync(fixture.directory))
        rmSync(fixture.directory, { recursive: true });
    }
  });
  it.each([false, true])(
    'waits for a partially written owned PID file rather than failing startup (empty=%s)',
    async (empty) => {
      state.partialPid = true;
      state.emptyPid = empty;
      const fixture = await createPostgresFixture(options());
      await fixture.close();
      expect(existsSync(fixture.directory)).toBe(false);
    },
  );
  it('rejects a connection to a different data directory without running business migrations', async () => {
    state.wrongDirectory = true;
    try {
      await expect(createPostgresFixture(options())).rejects.toThrow(
        'connection identity mismatch',
      );
    } finally {
      const directory = path.dirname(state.directory);
      expect(state.calls.some((call) => call[0].startsWith('pg_ctl'))).toBe(
        true,
      );
      expect(existsSync(path.join(state.directory, 'postmaster.pid'))).toBe(
        false,
      );
      if (existsSync(directory)) rmSync(directory, { recursive: true });
    }
  });
  it('retries port collisions only after the owned failed process exits', async () => {
    state.occupiedAttempts = 2;
    const fixture = await createPostgresFixture(options());
    expect(state.spawnCount).toBe(3);
    expect(
      state.calls.filter((call) => call[0].startsWith('pg_ctl')),
    ).toHaveLength(0);
    await fixture.close();
    expect(state.calls.at(-1)).toContain('stop');
  });
  it('keeps data when stop cannot be proved, then supports a proven cleanup retry', async () => {
    const fixture = await createPostgresFixture(options());
    const pidFile = path.join(fixture.directory, 'data/postmaster.pid');
    const original = readFileSync(pidFile, 'utf8');
    state.stopFails = true;
    await expect(fixture.close()).rejects.toThrow('simulated stop timeout');
    expect(readFileSync(pidFile, 'utf8')).toBe(original);
    state.stopFails = false;
    await fixture.close();
    expect(existsSync(fixture.directory)).toBe(false);
  });
  it('does not signal a PID file pointing at an unrelated process', async () => {
    const fixture = await createPostgresFixture(options());
    const pidFile = path.join(fixture.directory, 'data/postmaster.pid');
    const original = readFileSync(pidFile, 'utf8');
    writeFileSync(pidFile, original.replace(/^\d+/, '999999'));
    await expect(fixture.close()).rejects.toThrow('PID identity mismatch');
    expect(state.calls.some((call) => call[0].startsWith('pg_ctl'))).toBe(
      false,
    );
    writeFileSync(pidFile, original);
    await fixture.close();
  });
  it('restarts the same private cluster and preserves its data', async () => {
    const fixture = await createPostgresFixture(options());
    writeFileSync(
      path.join(fixture.directory, 'data/fixture-data'),
      'preserved',
    );
    await fixture.restart();
    expect(
      readFileSync(path.join(fixture.directory, 'data/fixture-data'), 'utf8'),
    ).toBe('preserved');
    expect(state.spawnCount).toBe(2);
    await fixture.close();
  });
});
