import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecurringTaskRegistry, RecurringTaskDefinition } from 'otto-core';
import { policyCollectionSlot, startPolicyRuntime } from './policyRuntime.js';
import { MemoryPolicyStore } from './policyStore.js';
import type { EnterprisePolicyService } from './policyService.js';
afterEach(() => vi.unstubAllEnvs());
describe('policy notification scheduling', () => {
  it('continues pending revisions instead of marking a slot complete before collection', async () => {
    vi.stubEnv('OTTO_POLICY_COLLECTION_ENABLED', 'true');
    const definitions: RecurringTaskDefinition[] = [];
    const store = new MemoryPolicyStore();
    const collect = vi.fn(async () => undefined);
    const stop = startPolicyRuntime(
      { collect } as unknown as EnterprisePolicyService,
      store,
      {
        register: (definition: RecurringTaskDefinition) => {
          definitions.push(definition);
          return () => undefined;
        },
      } as unknown as RecurringTaskRegistry,
    );
    const task = definitions.find((item) => item.name.endsWith('.collection'))!;
    const slot = policyCollectionSlot(new Date());
    expect(await task.getInputVersion()).toBe(`${slot}:0`);
    await task.run({} as never);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(await store.get('collection:schedule')).toBeNull();
    await store.update('collection:progress', () => ({
      slot,
      status: 'pending',
      revision: 4,
    }));
    expect(await task.getInputVersion()).toBe(`${slot}:4`);
    await store.update('collection:progress', () => ({
      slot,
      status: 'awaiting-next-slot',
      revision: 5,
    }));
    expect(await task.getInputVersion()).toBeUndefined();
    await store.update('collection:progress', () => ({
      slot: 'older-slot',
      status: 'awaiting-next-slot',
      revision: 5,
    }));
    expect(await task.getInputVersion()).toBe(`${slot}:5`);
    stop();
  });
  it('keeps free cached deadline reminders independent of disabled network collection', async () => {
    vi.stubEnv('OTTO_POLICY_COLLECTION_ENABLED', 'false');
    const definitions: RecurringTaskDefinition[] = [];
    const unregister = vi.fn();
    const registry = {
      register: (definition: RecurringTaskDefinition) => {
        definitions.push(definition);
        return unregister;
      },
    } as unknown as RecurringTaskRegistry;
    const refreshNotifications = vi.fn(async () => undefined);
    const stop = startPolicyRuntime(
      { refreshNotifications } as unknown as EnterprisePolicyService,
      new MemoryPolicyStore(),
      registry,
    );
    expect(definitions.map((d) => d.name)).toEqual([
      'enterprise.policy-intelligence.notifications',
    ]);
    expect(definitions[0].estimatedCostUsdPerRun).toBe(0);
    await definitions[0].run({} as never);
    expect(refreshNotifications).toHaveBeenCalledTimes(1);
    stop();
    await definitions[0].run({} as never);
    expect(refreshNotifications).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
