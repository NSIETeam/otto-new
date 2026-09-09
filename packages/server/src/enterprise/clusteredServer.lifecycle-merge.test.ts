/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core';
import { drainClusteredEnterpriseResources } from './clusteredServer.js';

afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function startPending(registry: RecurringTaskRegistry, name: string, promise: Promise<void>) {
  registry.register({ name, source: 'clustered-merge-test', intervalMs: 60_000,
    initialDelayMs: 0, missedRunPolicy: 'run-once', estimatedCostUsdPerRun: 0,
    getInputVersion: () => '1', run: () => promise });
}

it('preserves recruitment, inbox, market and carpool wiring with shared drain ownership', () => {
  const source = readFileSync(new URL('./clusteredServer.ts', import.meta.url), 'utf8');
  for (const capability of ['policy_intelligence_inbox_v1', 'park_flea_market_protocol_v1', 'recruitment_jobs_v1']) {
    expect(source).toContain(`'${capability}'`);
  }
  expect(source).toContain('...carpoolCommunicationCapabilities()');
  expect(source).toContain('registries: [marketTasks, recruitmentMaintenanceRegistry]');
  expect(source).toContain('repository.getPolicyIntelligenceStore(), options.taskRegistry');
  expect(source).not.toContain('drainMarket.finally(');
});

it('closes infrastructure only after both actual registries, readiness and HTTP are done', async () => {
  vi.useFakeTimers();
  const recruitment = new RecurringTaskRegistry();
  const market = new RecurringTaskRegistry();
  const recruiting = deferred(); const selling = deferred();
  const readiness = deferred(); const http = deferred();
  startPending(recruitment, 'recruitment', recruiting.promise);
  startPending(market, 'market', selling.promise);
  await vi.advanceTimersByTimeAsync(1);
  const close = vi.fn(async () => undefined);
  const stop = vi.fn();
  const draining = drainClusteredEnterpriseResources({ registries: [recruitment, market],
    initialized: readiness.promise, httpClosed: http.promise, stop, close, timeoutMs: 100 });
  expect(stop).toHaveBeenCalledOnce();
  recruiting.resolve(); readiness.resolve(); http.resolve();
  await vi.advanceTimersByTimeAsync(1);
  expect(close).not.toHaveBeenCalled();
  selling.resolve(); await draining;
  expect(close).toHaveBeenCalledOnce();
});

it.each(['recruitment', 'market'])('never closes infrastructure after the %s registry times out', async blocked => {
  vi.useFakeTimers();
  const recruitment = new RecurringTaskRegistry(); const market = new RecurringTaskRegistry();
  const pending = deferred();
  startPending(blocked === 'recruitment' ? recruitment : market, blocked, pending.promise);
  await vi.advanceTimersByTimeAsync(1);
  const close = vi.fn(async () => undefined);
  const result = drainClusteredEnterpriseResources({ registries: [recruitment, market],
    initialized: Promise.resolve(), httpClosed: Promise.resolve(), stop: () => undefined, close, timeoutMs: 10 })
    .then(() => null, error => error);
  await vi.advanceTimersByTimeAsync(11);
  expect(await result).toBeInstanceOf(Error);
  expect(close).not.toHaveBeenCalled();
  pending.resolve(); await vi.advanceTimersByTimeAsync(1);
  expect(close).not.toHaveBeenCalled();
});

it('does not close after rejected readiness or a readiness deadline', async () => {
  vi.useFakeTimers();
  const close = vi.fn(async () => undefined);
  await expect(drainClusteredEnterpriseResources({ registries: [],
    initialized: Promise.reject(new Error('readiness failed')), httpClosed: Promise.resolve(),
    stop: () => undefined, close, timeoutMs: 10 })).rejects.toThrow('readiness failed');
  const pending = deferred();
  const result = drainClusteredEnterpriseResources({ registries: [],
    initialized: pending.promise, httpClosed: Promise.resolve(), stop: () => undefined, close, timeoutMs: 10 })
    .then(() => null, error => error);
  await vi.advanceTimersByTimeAsync(11);
  expect(await result).toBeInstanceOf(Error);
  pending.resolve(); await vi.advanceTimersByTimeAsync(1);
  expect(close).not.toHaveBeenCalled();
});
