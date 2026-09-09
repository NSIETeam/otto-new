import { describe, expect, it, vi } from 'vitest';
import { MemoryPolicyStore } from './policyStore.js';
import {
  runPolicyCollectionTick,
  type PolicyCollectionProgress,
  type PolicyCollectionStep,
} from './policyCollectionCycle.js';

function harness(
  kind: PolicyCollectionStep<{ index: number }>['kind'],
  count = 100,
) {
  const store = new MemoryPolicyStore();
  let elapsed = 0;
  let date = new Date('2026-09-09T04:00:00Z');
  const run = vi.fn(async (data: { index: number }) => {
    elapsed += kind === 'source' ? 30_000 : 10;
    return { index: data.index + 1 };
  });
  const ports = {
    store,
    configuration: 'fixed-approved-sources',
    now: () => date,
    elapsedNow: () => elapsed,
    initial: () => ({ index: 0 }),
    next: (data: { index: number }) =>
      data.index >= count ? null : { kind, id: String(data.index), run },
    complete: vi.fn(async () => undefined),
  };
  return {
    store,
    ports,
    run,
    nextSlot: () => {
      date = new Date(date.getTime() + 12 * 3600_000);
    },
    advance: (milliseconds: number) => {
      elapsed += milliseconds;
    },
    setDate: (value: string) => {
      date = new Date(value);
    },
    advanceWall: (milliseconds: number) => {
      date = new Date(date.getTime() + milliseconds);
    },
  };
}
describe('durable policy collection cycle budgets', () => {
  it('charges active planning/checkpoint overhead as well as the page callbacks', async () => {
    const h = harness('page');
    const next = h.ports.next;
    h.ports.initial = () => {
      h.advance(20);
      return { index: 0 };
    };
    h.ports.next = (data) => {
      h.advance(30);
      return next(data);
    };
    await runPolicyCollectionTick(h.ports);
    expect(await h.store.get('collection:progress')).toMatchObject({
      spentMs: 210,
    });
  });
  it('conservatively charges a slot-boundary-spanning tick to the new slot rather than erasing its work', async () => {
    const h = harness('source');
    h.setDate('2026-09-09T10:29:50Z');
    h.run.mockImplementationOnce(async (data) => {
      h.advance(30_000);
      h.advanceWall(30_000);
      return { index: data.index + 1 };
    });
    await runPolicyCollectionTick(h.ports);
    const progress = await h.store.get<
      PolicyCollectionProgress<{ index: number }>
    >('collection:progress');
    expect(progress?.slot).toBe('2026-09-09:18:30');
    expect(progress?.spentMs).toBe(60_000);
    await runPolicyCollectionTick(h.ports);
    expect(
      (
        await h.store.get<PolicyCollectionProgress<{ index: number }>>(
          'collection:progress',
        )
      )?.spentMs,
    ).toBe(120_000);
  });
  it('checkpoints at most four local pages per tick and never marks a partial cycle complete', async () => {
    const h = harness('page');
    await runPolicyCollectionTick(h.ports);
    expect(h.run).toHaveBeenCalledTimes(4);
    expect(await h.store.get('collection:progress')).toMatchObject({
      status: 'pending',
      data: { index: 4 },
    });
    expect(h.ports.complete).not.toHaveBeenCalled();
    await runPolicyCollectionTick(h.ports);
    expect(h.run).toHaveBeenCalledTimes(8);
  });
  it('keeps the same cycle and source counters across ticks and new slots after 600 active seconds', async () => {
    const h = harness('source', 25);
    for (let i = 0; i < 11; i++) await runPolicyCollectionTick(h.ports);
    expect(h.run).toHaveBeenCalledTimes(20);
    const paused = await h.store.get<
      PolicyCollectionProgress<{ index: number }>
    >('collection:progress');
    expect(paused).toMatchObject({
      status: 'awaiting-next-slot',
      spentMs: 600_000,
      data: { index: 20 },
    });
    expect(h.ports.complete).not.toHaveBeenCalled();
    h.nextSlot();
    await runPolicyCollectionTick(h.ports);
    expect(await h.store.get('collection:progress')).toMatchObject({
      cycle: paused!.cycle,
      spentMs: 60_000,
      data: { index: 22 },
    });
    expect(h.run.mock.calls.map(([data]) => data.index)).toEqual(
      Array.from({ length: 22 }, (_, i) => i),
    );
    await runPolicyCollectionTick(h.ports);
    await runPolicyCollectionTick(h.ports);
    expect(h.ports.complete).toHaveBeenCalledTimes(1);
    await runPolicyCollectionTick(h.ports);
    expect(h.run).toHaveBeenCalledTimes(25);
  });
  it('reserves an external call before dispatch and does not retry an unknown paid outcome', async () => {
    const h = harness('model');
    h.run.mockImplementationOnce(async () => {
      expect(await h.store.get('collection:progress')).toMatchObject({
        spentMs: 90_000,
        reservation: { kind: 'model', id: '0' },
      });
      throw new Error('provider outcome unknown');
    });
    await runPolicyCollectionTick(h.ports);
    expect(await h.store.get('collection:progress')).toMatchObject({
      status: 'needs-review',
      data: { index: 0 },
      spentMs: 90_000,
    });
    h.nextSlot();
    await runPolicyCollectionTick(h.ports);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.ports.complete).not.toHaveBeenCalled();
  });
  it('recovers an interrupted local page without refunding its unknown reservation', async () => {
    const h = harness('page');
    await h.store.update('collection:progress', () => ({
      version: 1,
      cycle: 'saved-cycle',
      configuration: h.ports.configuration,
      slot: '2026-09-09:03:00',
      spentMs: 5000,
      revision: 1,
      status: 'pending',
      data: { index: 0 },
      reservation: { kind: 'page', id: '0', milliseconds: 5000 },
      lease: { token: 'dead-process', until: 0 },
    }));
    await runPolicyCollectionTick(h.ports);
    expect(await h.store.get('collection:progress')).toMatchObject({
      cycle: 'saved-cycle',
      spentMs: 5040,
      data: { index: 4 },
    });
  });
  it('does not reset a partially consumed cycle when the source configuration changes', async () => {
    const h = harness('source');
    await runPolicyCollectionTick(h.ports);
    await runPolicyCollectionTick({
      ...h.ports,
      configuration: 'changed-sources',
    });
    expect(await h.store.get('collection:progress')).toMatchObject({
      status: 'needs-review',
      data: { index: 2 },
      spentMs: 60000,
    });
    expect(h.run).toHaveBeenCalledTimes(2);
  });
});
