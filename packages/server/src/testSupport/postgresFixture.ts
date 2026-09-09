/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
// Test-only private clusters. Never accept a connection URL or manage a service.
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
class FixtureConnectionIdentityError extends Error {}
type Binaries = { initdb: string; postgres: string; pg_ctl: string };
interface Options {
  binaryDirectory?: string;
  user: string;
  prefix: string;
  max?: number;
}
const cleanEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^PG/i.test(key)),
  );

export function resolvePostgresBinaries({
  binaryDirectory,
  environment = process.env,
  platform = process.platform,
}: {
  binaryDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): Binaries {
  const extension = platform === 'win32' ? '.exe' : '';
  const executable = (file: string) => {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const fromDirectory = (directory: string): Binaries | undefined => {
    if (!path.isAbsolute(directory)) return undefined;
    const tools = {
      initdb: path.join(directory, `initdb${extension}`),
      postgres: path.join(directory, `postgres${extension}`),
      pg_ctl: path.join(directory, `pg_ctl${extension}`),
    };
    return Object.values(tools).every(executable) ? tools : undefined;
  };
  const explicit = binaryDirectory ?? environment.OTTO_TEST_POSTGRES_BIN;
  if (explicit !== undefined) {
    const tools = fromDirectory(explicit);
    if (tools) return tools;
    throw new Error(
      'PostgreSQL test binary override is incomplete: supply an absolute directory containing initdb, postgres and pg_ctl via OTTO_TEST_POSTGRES_BIN. Tests are not skipped.',
    );
  }
  const directories = (environment.PATH ?? environment.Path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean);
  // An injected test platform must not split a native Windows drive letter.
  if (
    platform !== process.platform &&
    environment.PATH &&
    path.isAbsolute(environment.PATH)
  )
    directories.splice(0, directories.length, environment.PATH);
  for (const directory of directories) {
    const tools = fromDirectory(directory);
    if (tools) return tools;
  }
  for (const directory of directories) {
    const config = path.join(directory, `pg_config${extension}`);
    if (!executable(config)) continue;
    try {
      const tools = fromDirectory(
        execFileSync(config, ['--bindir'], {
          encoding: 'utf8',
          timeout: 3000,
          maxBuffer: 65536,
          env: cleanEnvironment(),
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      );
      if (tools) return tools;
    } catch {
      /* Client-only or stale pg_config is not a PostgreSQL server. */
    }
  }
  throw new Error(
    'PostgreSQL test tools unavailable (initdb, postgres, pg_ctl). Set OTTO_TEST_POSTGRES_BIN or add the complete server bin directory to PATH. Tests are not skipped.',
  );
}

export async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  phase: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`PostgreSQL fixture ${phase} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function postgresArguments(directory: string, port: number): string[] {
  return [
    '-D',
    directory,
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-c',
    'unix_socket_directories=',
    '-c',
    'max_connections=20',
    '-c',
    'shared_buffers=16MB',
  ];
}
export function fixturePoolConfig(
  port: number,
  user: string,
  password: string,
  max: number,
): pg.PoolConfig {
  return {
    host: '127.0.0.1',
    port,
    user,
    password,
    database: 'postgres',
    max,
    ssl: false,
    options: '',
    connectionTimeoutMillis: 1000,
    application_name: 'otto-isolated-test',
  };
}
async function availablePort(): Promise<number> {
  const reservation = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('PostgreSQL fixture port allocation failed');
    return address.port;
  } finally {
    if (reservation.listening)
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
  }
}

export async function createPostgresFixture(options: Options) {
  const binaries = resolvePostgresBinaries({
    binaryDirectory: options.binaryDirectory,
  });
  if (
    !/^[a-z][a-z0-9_]{0,40}$/.test(options.user) ||
    !/^otto-[a-z-]+-$/.test(options.prefix)
  )
    throw new Error('Invalid PostgreSQL fixture identity');
  const max = options.max ?? 4;
  if (!Number.isInteger(max) || max < 1 || max > 16)
    throw new Error('Invalid PostgreSQL fixture pool size');
  const directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), options.prefix)),
  );
  const identity = statSync(directory);
  const data = path.join(directory, 'data');
  const passwordFile = path.join(directory, 'password');
  const password = randomBytes(32).toString('hex');
  writeFileSync(passwordFile, `${password}\n`, { flag: 'wx', mode: 0o600 });
  let server: ChildProcess | undefined;
  let serverExit: Promise<number | null> | undefined;
  let ended = true;
  let pool: pg.Pool | undefined;
  let initialized = false;
  let closed = false;
  let poolFailure: Error | undefined;
  const connections = new Set<pg.PoolClient>();
  const safeDirectory = () => {
    const current = lstatSync(directory);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      realpathSync(directory) !== directory
    )
      throw new Error(
        'PostgreSQL fixture directory identity changed; preserved for inspection',
      );
  };
  const command = async (file: string, args: string[], timeout: number) => {
    safeDirectory();
    await exec(file, args, {
      env: cleanEnvironment(),
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  };
  const ownedPidFile = (port?: number) => {
    const file = path.join(data, 'postmaster.pid');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error('PostgreSQL fixture PID file invalid');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    if (port !== undefined && (!lines[0] || !lines[1])) return false;
    if (
      Number(lines[0]) !== server?.pid ||
      path.resolve(lines[1] ?? '') !== data
    )
      throw new Error('PostgreSQL fixture PID identity mismatch');
    if (port !== undefined) {
      // PostgreSQL adds startup details and then "ready" to the PID file in
      // separate writes. Partial owned state is not a foreign cluster.
      if (!lines[3] || lines[7]?.trim() !== 'ready') return false;
      if (Number(lines[3]) !== port)
        throw new Error('PostgreSQL fixture PID identity mismatch');
    }
    return true;
  };
  const exitCleanup = () => {
    if (!server || ended) return;
    // Best-effort fallback for a test worker's normal exit. Only this fixture's
    // attested PID may be signalled; any unknown state retains its directory.
    process.exitCode = 1;
    try {
      safeDirectory();
      ownedPidFile();
      execFileSync(
        binaries.pg_ctl,
        ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop'],
        {
          env: cleanEnvironment(),
          timeout: 12_000,
          killSignal: 'SIGKILL',
          windowsHide: true,
          stdio: 'ignore',
        },
      );
    } catch {
      /* Explicit close is required for a successful test run. */
    }
  };
  process.once('exit', exitCleanup);
  const drain = async () => {
    const ending = [...connections].map(
      (client) => new Promise<void>((resolve) => client.once('end', resolve)),
    );
    await bounded(
      (async () => {
        await pool?.end();
        await Promise.all(ending);
      })(),
      5000,
      'pool drain',
    );
    pool = undefined;
    if (poolFailure)
      throw new Error(
        'PostgreSQL fixture pool reported an unexpected failure',
        { cause: poolFailure },
      );
  };
  const stop = async () => {
    if (!server) return;
    if (!ended) {
      // pg_ctl may only signal the process we spawned, never a foreign PID/port.
      ownedPidFile();
      await command(
        binaries.pg_ctl,
        ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop'],
        12_000,
      );
    }
    const status = await bounded(serverExit!, 2000, 'process exit');
    if (status !== 0)
      throw new Error('PostgreSQL fixture did not exit cleanly');
    if (existsSync(path.join(data, 'postmaster.pid')))
      throw new Error('PostgreSQL fixture stop unknown; PID file retained');
    server = undefined;
  };
  const connect = (port: number) => {
    const next = new pg.Pool(
      fixturePoolConfig(port, options.user, password, max),
    );
    next.on('connect', (client) => {
      connections.add(client);
      client.once('end', () => connections.delete(client));
    });
    // Shutdown errors are returned by the bounded drain/stop path, not unhandled
    // event exceptions that would conceal which cluster remains alive.
    next.on('error', (error) => {
      poolFailure ??= error;
    });
    return next;
  };
  const start = async () => {
    const deadline = Date.now() + 15_000;
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await availablePort();
      const log = openSync(path.join(directory, 'postgres.log'), 'a', 0o600);
      try {
        server = spawn(binaries.postgres, postgresArguments(data, port), {
          env: cleanEnvironment(),
          windowsHide: true,
          stdio: ['ignore', log, log],
        });
      } finally {
        closeSync(log);
      }
      ended = false;
      serverExit = new Promise<number | null>((resolve) => {
        server!.once('error', () => {
          ended = true;
          resolve(null);
        });
        server!.once('exit', (code) => {
          ended = true;
          resolve(code);
        });
      });
      server.unref();
      while (Date.now() < deadline && !ended) {
        try {
          if (!ownedPidFile(port)) {
            await delay(50);
            continue;
          }
          const candidate = connect(port);
          try {
            const result = await bounded(
              candidate.query(
                "SELECT current_setting('data_directory') AS directory",
              ),
              1500,
              'identity query',
            );
            if (
              path.resolve(String(result.rows[0]?.directory)) !== data ||
              ended
            )
              throw new FixtureConnectionIdentityError(
                'PostgreSQL fixture connection identity mismatch',
              );
            pool = candidate;
            return;
          } catch (error) {
            await bounded(candidate.end(), 2000, 'failed connection drain');
            if (error instanceof FixtureConnectionIdentityError) throw error;
          }
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
            existsSync(path.join(data, 'postmaster.pid'))
          )
            throw error;
        }
        await delay(50);
      }
      if (!ended)
        throw new Error(
          `PostgreSQL fixture startup timed out; evidence: ${directory}`,
        );
      if (existsSync(path.join(data, 'postmaster.pid')))
        throw new Error(
          `PostgreSQL fixture failed startup left an unknown PID; evidence: ${directory}`,
        );
      server = undefined;
      if (Date.now() >= deadline) break;
      // Port allocation is inherently racy. Only retry after our own child has
      // exited and removed its PID file; never kill the occupying process.
    }
    throw new Error(
      `PostgreSQL fixture could not start after 3 isolated attempts; evidence: ${directory}`,
    );
  };
  const close = async (preserve = false) => {
    if (closed) return;
    safeDirectory();
    let drainFailure: unknown;
    try {
      await drain();
    } catch (error) {
      drainFailure = error;
    }
    // Still stop our owned server if a test leaked a checked-out connection.
    await stop();
    if (drainFailure) throw drainFailure;
    if (!initialized)
      throw new Error(
        `PostgreSQL fixture initialization failed; evidence preserved: ${directory}`,
      );
    safeDirectory();
    if (!preserve) rmSync(directory, { recursive: true });
    closed = true;
    process.removeListener('exit', exitCleanup);
  };
  try {
    await command(
      binaries.initdb,
      [
        '-D',
        data,
        '-U',
        options.user,
        '-A',
        'scram-sha-256',
        '--pwfile',
        passwordFile,
        '--no-locale',
        '--encoding=UTF8',
      ],
      20_000,
    );
    initialized = true;
    await start();
    return {
      directory,
      get pool() {
        if (!pool) throw new Error('PostgreSQL fixture is not running');
        return pool;
      },
      async restart() {
        await drain();
        await stop();
        await start();
      },
      close: () => close(),
    };
  } catch (error) {
    try {
      await close(true);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        `PostgreSQL fixture failed; cleanup incomplete, preserved: ${directory}`,
      );
    }
    throw error;
  }
}
