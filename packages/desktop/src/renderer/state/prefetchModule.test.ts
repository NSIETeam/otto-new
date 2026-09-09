import { it, expect, vi } from 'vitest';
import { prefetchModule } from './prefetchModule.js';
import { ModuleReadCache } from './moduleReadCache.js';

it('does not execute agents, writes, or unavailable modules during intent prefetch', async () => {
  const get = vi.fn(async () => ({}));
  const execute = vi.fn();
  Object.assign(window.otto, { enterpriseParkCarpoolGet: get, enterpriseParkCarpoolWorkflowExecute: execute });
  const cache = new ModuleReadCache();
  await prefetchModule({ availability: 'disabled', activation: { kind: 'dialog', dialog: 'park-carpool' } }, cache);
  expect(get).not.toHaveBeenCalled();
  await prefetchModule({ availability: 'available', activation: { kind: 'dialog', dialog: 'park-carpool' } }, cache);
  await prefetchModule({ availability: 'available', activation: { kind: 'dialog', dialog: 'park-carpool' } }, cache);
  expect(get).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});
