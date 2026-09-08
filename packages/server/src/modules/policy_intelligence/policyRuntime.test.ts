import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecurringTaskRegistry, RecurringTaskDefinition } from 'otto-core';
import { startPolicyRuntime } from './policyRuntime.js';
import { MemoryPolicyStore } from './policyStore.js';
import type { EnterprisePolicyService } from './policyService.js';
afterEach(() => vi.unstubAllEnvs());
describe('policy notification scheduling', () => {
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
