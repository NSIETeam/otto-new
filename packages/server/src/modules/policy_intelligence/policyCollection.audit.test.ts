/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnterprisePolicyService } from './policyService.js';
import { MemoryPolicyStore } from './policyStore.js';
import { initialPolicyCollection } from './policyCollection.js';
import {
  policyCollectionSlot,
  runPolicyCollectionTick,
} from './policyCollectionCycle.js';
import { policyHash } from './policyDomain.js';
import type { OfficialPolicyDocument } from './contracts.js';
import { startPolicyRuntime } from './policyRuntime.js';
import type { RecurringTaskDefinition, RecurringTaskRegistry } from 'otto-core';

afterEach(() => vi.unstubAllEnvs());

describe('independent policy cycle audit boundaries', () => {
  it('aborts an active collection and prevents both retained callbacks from dispatching after stop', async () => {
    vi.stubEnv('OTTO_POLICY_COLLECTION_ENABLED', 'true');
    const definitions: RecurringTaskDefinition[] = [];
    const unregister = vi.fn();
    let collectionSignal: AbortSignal | undefined;
    const collect = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          collectionSignal = signal;
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const refreshNotifications = vi.fn(async () => undefined);
    const stop = startPolicyRuntime(
      { collect, refreshNotifications } as unknown as EnterprisePolicyService,
      new MemoryPolicyStore(),
      {
        register(definition: RecurringTaskDefinition) {
          definitions.push(definition);
          return unregister;
        },
      } as unknown as RecurringTaskRegistry,
    );
    const collection = definitions.find((task) =>
      task.name.endsWith('.collection'),
    )!;
    const flight = collection.run();
    expect(collectionSignal?.aborted).toBe(false);
    stop();
    await flight;
    expect(collectionSignal?.aborted).toBe(true);
    for (const task of definitions) await task.run();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(refreshNotifications).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(2);
  });
  it('preserves a dispatched extraction failure as an unknown paid reservation', async () => {
    const store = new MemoryPolicyStore();
    let now = new Date('2026-09-09T04:00:00Z');
    const extract = vi.fn(async () => {
      throw new Error('connection lost after provider accepted');
    });
    const service = new EnterprisePolicyService({
      store,
      sources: [],
      now: () => now,
      getActor: async () => null,
      model: { name: 'audit-no-network', extract, analyze: vi.fn() },
    });
    const doc: OfficialPolicyDocument = {
      id: 'audit-policy',
      title: 'Audit fixture',
      url: 'https://www.gov.cn/audit',
      sourceId: 'national',
      sourceName: 'Fixture',
      issuer: 'Fixture',
      level: 'national',
      region: { country: 'CN' },
      categories: [],
      fetchedAt: now.toISOString(),
      contentHash: 'audit-v1',
      version: 1,
      bodyText: 'Public fixture text',
      summary: '',
      supportText: '',
      conditions: [],
      conditionTree: { all: [] },
      materials: [],
      resources: [],
      attachments: [],
      sourceStatus: 'verified',
      interpretationStatus: 'pending',
    };
    await store.update('document:audit-policy', () => doc);
    await store.update('workspace:audit', () => ({ enabled: true }));
    await store.update('collection:progress', () => ({
      version: 1,
      cycle: 'audit-cycle',
      configuration: policyHash([]),
      slot: policyCollectionSlot(now),
      revision: 1,
      spentMs: 0,
      status: 'pending',
      data: {
        ...initialPolicyCollection(),
        stage: 'extract',
        analyzeEnabled: true,
        pendingExtraction: [doc.id],
        extractionWorkspace: 'workspace:audit',
      },
    }));
    await service.collect();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await store.get('collection:progress')).toMatchObject({
      status: 'needs-review',
      spentMs: expect.any(Number),
      reservation: { kind: 'model' },
      data: { extractionIndex: 0 },
    });
    expect(
      (await store.get<{ spentMs: number }>('collection:progress'))!.spentMs,
    ).toBeGreaterThanOrEqual(90_000);
    now = new Date('2026-09-10T04:00:00Z');
    await service.collect();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await store.get('collection:status')).toBeNull();
  });

  it('records a received but invalid extraction as a known validation failure, not an unknown call', async () => {
    const store = new MemoryPolicyStore();
    const now = new Date('2026-09-09T04:00:00Z');
    const extract = vi.fn(async () => ({ exclusionsReviewed: false }));
    const service = new EnterprisePolicyService({
      store,
      sources: [],
      now: () => now,
      getActor: async () => null,
      model: { name: 'audit-no-network', extract, analyze: vi.fn() },
    });
    await store.update('document:audit-policy', () => ({
      id: 'audit-policy',
      sourceId: 'national',
      sourceStatus: 'verified',
      contentHash: 'audit-v1',
      attachments: [],
      interpretationStatus: 'pending',
    }));
    await store.update('workspace:audit', () => ({ enabled: true }));
    await store.update('collection:progress', () => ({
      version: 1,
      cycle: 'audit-cycle',
      configuration: policyHash([]),
      slot: policyCollectionSlot(now),
      revision: 1,
      spentMs: 0,
      status: 'pending',
      data: {
        ...initialPolicyCollection(),
        stage: 'extract',
        analyzeEnabled: true,
        pendingExtraction: ['audit-policy'],
        extractionWorkspace: 'workspace:audit',
      },
    }));
    await service.collect();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await store.get('collection:progress')).toMatchObject({
      status: 'pending',
      reservation: undefined,
      data: { extractionIndex: 1 },
    });
    expect(await store.get('document:audit-policy')).toMatchObject({
      interpretationStatus: 'failed',
    });
  });

  it('never resets unknown old-slot reservations before evaluating their outcome', async () => {
    for (const kind of ['source', 'model'] as const) {
      const store = new MemoryPolicyStore();
      await store.update('collection:progress', () => ({
        version: 1,
        cycle: 'old-cycle',
        configuration: 'fixed',
        slot: '2026-09-08:03:00',
        revision: 4,
        spentMs: 590_000,
        status: 'pending',
        data: { index: 7 },
        reservation: { kind, id: 'unknown', milliseconds: 30_000 },
        lease: { token: 'dead-process', until: 0 },
      }));
      const next = vi.fn();
      const complete = vi.fn();
      await runPolicyCollectionTick({
        store,
        configuration: 'fixed',
        now: () => new Date('2026-09-09T04:00:00Z'),
        initial: () => ({ index: 0 }),
        next,
        complete,
      });
      expect(next).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(await store.get('collection:progress')).toMatchObject({
        cycle: 'old-cycle',
        slot: '2026-09-08:03:00',
        spentMs: 590_000,
        status: 'needs-review',
        data: { index: 7 },
        reservation: { kind, id: 'unknown' },
      });
    }
  });
});
