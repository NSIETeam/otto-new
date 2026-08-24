#!/usr/bin/env node
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { hostname } from 'node:os';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  buildNodePostgresPoolConfig,
  createNodePostgresPool,
  createPostgresDatabaseLifecycle,
  resolveEnterpriseDatabaseTopology,
} from '../data_platform/index.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from '../../enterprise/postgresMigrations.js';
import { createPostgresDurableWorkflowRepository } from './postgresRepository.js';
import { createDefaultDurableWorkflowTaskRegistry } from './taskRegistry.js';
import { DurableWorkflowWorker } from './worker.js';

function integerSetting(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be from ${min} to ${max}`);
  }
  return value;
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startDurableWorkflowWorkerProcess(): Promise<{
  close(): Promise<void>;
}> {
  const topology = resolveEnterpriseDatabaseTopology({
    environment: process.env,
    sqliteDatabasePath: 'workflow-worker-does-not-open-sqlite.db',
  });
  if (topology.backend !== 'postgresql') {
    throw new Error(
      'Durable workflow Worker requires PostgreSQL enterprise mode',
    );
  }
  const pool = createNodePostgresPool(
    buildNodePostgresPoolConfig({
      connectionString: topology.connectionString,
      environment: process.env,
    }),
  );
  const database = createPostgresDatabaseLifecycle({
    pool,
    migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
  });
  await database.initialize();
  const store = createPostgresDurableWorkflowRepository({ pool });
  const registry = createDefaultDurableWorkflowTaskRegistry();
  const workerId =
    process.env.OTTO_WORKFLOW_WORKER_ID?.trim() ||
    `${hostname()}:${process.pid}`;
  const worker = new DurableWorkflowWorker(store, registry, workerId, {
    leaseMs: integerSetting('OTTO_WORKFLOW_LEASE_MS', 30_000, 1_000, 600_000),
    pollMs: integerSetting('OTTO_WORKFLOW_POLL_MS', 1_000, 25, 60_000),
    concurrency: integerSetting('OTTO_WORKFLOW_CONCURRENCY', 2, 1, 32),
    shutdownGraceMs: integerSetting(
      'OTTO_WORKFLOW_SHUTDOWN_GRACE_MS',
      10_000,
      100,
      600_000,
    ),
    recoverySweepMs: integerSetting(
      'OTTO_WORKFLOW_RECOVERY_SWEEP_MS',
      5_000,
      100,
      60_000,
    ),
  });
  await worker.start();

  const healthHost =
    process.env.OTTO_WORKFLOW_HEALTH_HOST?.trim() || '127.0.0.1';
  const healthPort = integerSetting(
    'OTTO_WORKFLOW_HEALTH_PORT',
    7781,
    1,
    65_535,
  );
  const health = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    void (async () => {
      let databaseReady = true;
      try {
        await pool.query('SELECT 1');
      } catch {
        databaseReady = false;
      }
      const workerStatus = worker.status();
      const ready = databaseReady && workerStatus.running;
      res.writeHead(ready ? 200 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(ready ? {} : { 'Retry-After': '5' }),
      });
      res.end(
        JSON.stringify({
          status: ready ? 'ok' : 'degraded',
          queue: databaseReady ? 'ready' : 'unavailable',
          worker: workerStatus,
          taskTypeCount: registry.taskTypes().length,
        }),
      );
    })();
  });
  await listen(health, healthPort, healthHost);

  let closing: Promise<void> | null = null;
  return {
    close(): Promise<void> {
      closing ??= (async () => {
        await Promise.allSettled([closeServer(health), worker.close()]);
        await database.close();
      })();
      return closing;
    },
  };
}

async function main(): Promise<void> {
  const runtime = await startDurableWorkflowWorkerProcess();
  const shutdown = (): void => {
    void runtime.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log('[Otto Workflow Worker] PostgreSQL queue is ready');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    console.error(
      `[Otto Workflow Worker] startup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
