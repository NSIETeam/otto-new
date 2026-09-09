import { describe, expect, it, vi } from 'vitest';
import { MemoryPolicyStore } from './policyStore.js';
import {
  initialPolicyCollection,
  nextPolicyCollectionStep,
  type PolicyCollectionData,
  type PolicyCollectionPorts,
} from './policyCollection.js';
import {
  runPolicyCollectionTick,
  type PolicyCollectionProgress,
} from './policyCollectionCycle.js';
import type { OfficialPolicyDocument, PolicySource } from './contracts.js';

const source = (id: string): PolicySource => ({
  id,
  name: id,
  listUrl: `https://www.gov.cn/${id}/`,
  allowedHosts: ['www.gov.cn'],
  level: 'national',
  region: { country: 'CN' },
});
const document = (id: string): OfficialPolicyDocument => ({
  id,
  title: id,
  url: `https://www.gov.cn/${id}`,
  sourceId: 'one',
  sourceName: 'one',
  issuer: 'one',
  level: 'national',
  region: { country: 'CN' },
  categories: [],
  fetchedAt: '2026-08-01T00:00:00Z',
  bodyText: '需要核验的政策正文'.repeat(1024),
  contentHash: id,
  version: 1,
  summary: '',
  supportText: '',
  conditions: [],
  materials: [],
  resources: [],
  attachments: [],
  sourceStatus: 'verified',
  interpretationStatus: 'ready',
});
function harness() {
  const store = new MemoryPolicyStore();
  const ports: PolicyCollectionPorts = {
    store,
    sources: [source('one'), source('two'), source('three')],
    now: () => new Date('2026-09-09T04:00:00Z'),
    collectSource: vi.fn(async (_source, _known, _priority, slots) => ({
      pendingIds: Array.from({ length: slots }, (_, i) => `extracted-${i}`),
    })),
    reconcile: vi.fn(async () => undefined),
    interpret: vi.fn(async () => undefined),
    recommendationTarget: vi.fn(async () => ({
      generation: 1,
      region: { country: 'CN' },
    })),
    recommendationCandidate: vi.fn(async () => true),
    recommend: vi.fn(async () => undefined),
  };
  const tick = () =>
    runPolicyCollectionTick({
      store,
      configuration: 'sources',
      now: ports.now,
      initial: () => initialPolicyCollection(ports.sources),
      next: (data) => nextPolicyCollectionStep(ports, data),
      complete: async () => undefined,
    });
  const progress = () =>
    store.get<PolicyCollectionProgress<PolicyCollectionData>>(
      'collection:progress',
    );
  return { store, ports, tick, progress };
}
describe('bounded policy collection traversal', () => {
  it('leaves a disabled or changed enterprise before reading another recommendation page', async () => {
    const h = harness();
    h.ports.recommendationTarget = vi.fn(async () => null);
    await h.store.update('document:p', () => document('p'));
    const reads = vi.spyOn(h.store, 'getBounded');
    const data: PolicyCollectionData = {
      ...initialPolicyCollection(h.ports.sources),
      stage: 'recommend-documents',
      recommendation: {
        workspaceKey: 'workspace:a',
        generation: 1,
        region: { country: 'CN' },
        candidates: [],
        index: 0,
        attempts: 0,
        spentMs: 0,
      },
    };
    const next = await nextPolicyCollectionStep(h.ports, data)!.run(data, {
      cycle: 'cycle',
      signal: new AbortController().signal,
    });
    expect(next.stage).toBe('recommend-workspaces');
    expect(reads.mock.calls.some(([key]) => key.startsWith('document:'))).toBe(
      false,
    );
  });
  it('retains the enterprise-wide 90 second budget across recommendation ticks', async () => {
    const h = harness();
    let elapsed = 0;
    h.ports.elapsedNow = () => elapsed;
    h.ports.recommend = vi.fn(async () => {
      elapsed += 40_000;
    });
    let data: PolicyCollectionData = {
      ...initialPolicyCollection(h.ports.sources),
      stage: 'recommend-model',
      recommendation: {
        workspaceKey: 'workspace:a',
        generation: 1,
        region: { country: 'CN' },
        candidates: [
          { id: 'a', date: '' },
          { id: 'b', date: '' },
        ],
        index: 1,
        attempts: 0,
        spentMs: 10_000,
        selected: 'a',
      },
    };
    let step = nextPolicyCollectionStep(h.ports, data)!;
    expect(step.maxMilliseconds).toBe(80_000);
    data = await step.run(data, {
      cycle: 'cycle',
      signal: new AbortController().signal,
    });
    expect(data.recommendation?.spentMs).toBe(50_000);
    data = await nextPolicyCollectionStep(h.ports, data)!.run(data, {
      cycle: 'cycle',
      signal: new AbortController().signal,
    });
    step = nextPolicyCollectionStep(h.ports, data)!;
    expect(step.maxMilliseconds).toBe(40_000);
    data = await step.run(data, {
      cycle: 'cycle',
      signal: new AbortController().signal,
    });
    data = await nextPolicyCollectionStep(h.ports, data)!.run(data, {
      cycle: 'cycle',
      signal: new AbortController().signal,
    });
    expect(data.stage).toBe('recommend-workspaces');
    expect(data.recommendation).toBeUndefined();
  });
  it('keeps only 16 lightweight rechecks per source and eight extraction IDs across a large cache', async () => {
    const h = harness();
    await h.store.update('workspace:one', () => ({ enabled: true }));
    for (let i = 0; i < 2000; i++)
      await h.store.update(`document:${i.toString().padStart(4, '0')}`, () =>
        document(i.toString().padStart(4, '0')),
      );
    vi.spyOn(h.store, 'list').mockRejectedValue(
      new Error('unbounded cache list'),
    );
    const reads = vi.spyOn(h.store, 'getBounded');
    for (
      let i = 0;
      i < 30 && (await h.progress())?.data.stage !== 'recommend-workspaces';
      i++
    ) {
      reads.mockClear();
      const before = vi.mocked(h.ports.collectSource).mock.calls.length;
      await h.tick();
      expect(
        reads.mock.calls.filter(([key]) => key.startsWith('document:')).length,
      ).toBeLessThanOrEqual(128);
      expect(
        vi.mocked(h.ports.collectSource).mock.calls.length - before,
      ).toBeLessThanOrEqual(2);
    }
    const candidates = await h.store.get<{ documents: unknown[] }>(
      'collection-candidates:one',
    );
    expect(candidates?.documents).toHaveLength(16);
    expect(JSON.stringify(candidates)).not.toContain('bodyText');
    expect((await h.progress())?.data.pendingExtraction).toHaveLength(8);
    expect(h.ports.interpret).toHaveBeenCalledTimes(8);
    expect(h.ports.collectSource).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(h.ports.collectSource).mock.calls.map((args) => args[3]),
    ).toEqual([8, 0, 0]);
  });
  it('finishes an empty cache and gives each enabled enterprise at most eight recommendations without state() or full lists', async () => {
    const h = harness();
    h.ports.collectSource = vi.fn(async () => ({ pendingIds: [] }));
    await h.tick();
    expect((await h.progress())?.status).toBe('pending');
    for (let i = 0; i < 6; i++) await h.tick();
    expect((await h.progress())?.status).toBe('complete');
    const users = harness();
    users.ports.collectSource = vi.fn(async () => ({ pendingIds: [] }));
    for (const id of ['a', 'b', 'c'])
      await users.store.update(`workspace:${id}`, () => ({ enabled: true }));
    for (let i = 0; i < 12; i++)
      await users.store.update(`document:p${i}`, () => document(`p${i}`));
    vi.spyOn(users.store, 'list').mockRejectedValue(
      new Error('unbounded list'),
    );
    for (
      let i = 0;
      i < 60 && (await users.progress())?.status !== 'complete';
      i++
    )
      await users.tick();
    expect((await users.progress())?.status).toBe('complete');
    expect(users.ports.recommend).toHaveBeenCalledTimes(24);
    for (const id of ['a', 'b', 'c'])
      expect(
        vi
          .mocked(users.ports.recommend)
          .mock.calls.filter(([key]) => key === `workspace:${id}`),
      ).toHaveLength(8);
  });
});
