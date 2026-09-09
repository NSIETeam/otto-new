import { describe, expect, it, vi } from 'vitest';
import type { OfficialPolicyDocument, PolicyActor } from './contracts.js';
import {
  emptyPolicyMailbox,
  policyMailboxKey,
  watchPolicy,
  type PolicyMailbox,
} from './policyNotifications.js';
import { MemoryPolicyStore } from './policyStore.js';
import {
  refreshPolicyNotifications,
  policyNotificationHealthKey,
  type PolicyNotificationProgress,
} from './policyNotificationRuntime.js';

const doc: OfficialPolicyDocument = {
  id: 'p',
  title: '政策',
  url: 'https://www.gov.cn/p',
  sourceId: 'national',
  sourceName: '国务院',
  issuer: '国务院',
  level: 'national',
  region: { country: 'CN' },
  categories: [],
  deadline: '2026-10-01',
  fetchedAt: '2026-09-03T00:00:00Z',
  bodyText: '原文',
  contentHash: 'v1',
  version: 1,
  summary: '',
  supportText: '',
  conditions: [],
  materials: [],
  resources: [],
  attachments: [],
  sourceStatus: 'verified',
  interpretationStatus: 'ready',
};
function harness() {
  const store = new MemoryPolicyStore();
  const actors = new Map<string, PolicyActor>();
  const actor = (id: string): PolicyActor => ({
    id,
    organizationId: id,
    organizationName: id,
    active: true,
    isAdmin: true,
  });
  const ports = {
    store,
    now: () => new Date('2026-09-30T00:00:00Z'),
    getActor: vi.fn(async (id: string) => actors.get(id) ?? null),
    workspace: vi.fn(async () => ({
      enabled: true,
      region: { country: 'CN' as const },
    })),
  };
  const add = async (id: string, ids = ['p']) => {
    const user = actor(id);
    actors.set(id, user);
    for (const policyId of ids) {
      await store.update(`document:${policyId}`, () => ({
        ...doc,
        id: policyId,
      }));
      await watchPolicy(store, user, { ...doc, id: policyId }, true);
    }
    return user;
  };
  return { store, ports, add, actors };
}
describe('bounded durable policy notification traversal', () => {
  it('visits 70 enterprises fairly over 32-mailbox ticks without loading all bodies', async () => {
    const h = harness();
    for (let i = 0; i < 70; i++) await h.add(`user-${i}`);
    vi.spyOn(h.store, 'list').mockRejectedValue(new Error('unbounded list'));
    const reads = vi.spyOn(h.store, 'getBounded');
    await refreshPolicyNotifications(h.ports);
    expect(
      reads.mock.calls.filter(([key]) => key.startsWith('policy-inbox:')),
    ).toHaveLength(32);
    expect(
      (await h.store.get<PolicyNotificationProgress>('notification:progress'))
        ?.lastCompletedAt,
    ).toBeUndefined();
    await refreshPolicyNotifications(h.ports);
    await refreshPolicyNotifications(h.ports);
    for (const user of h.actors.values())
      expect(
        (await h.store.get<PolicyMailbox>(policyMailboxKey(user)))?.notices,
      ).toHaveLength(1);
    expect(
      (await h.store.get<PolicyNotificationProgress>('notification:progress'))
        ?.lastCompletedAt,
    ).toBe('2026-09-30T00:00:00.000Z');
    await refreshPolicyNotifications(h.ports);
    for (const user of h.actors.values())
      expect(
        (await h.store.get<PolicyMailbox>(policyMailboxKey(user)))?.notices,
      ).toHaveLength(1);
  });
  it('resumes a partly observed mailbox after the time budget and preserves read acknowledgements', async () => {
    const h = harness();
    const user = await h.add('user', ['a', 'b', 'c']);
    let elapsed = 0;
    h.ports.getActor.mockImplementation(async (id) => {
      elapsed += 1300;
      return h.actors.get(id) ?? null;
    });
    await refreshPolicyNotifications({ ...h.ports, elapsedNow: () => elapsed });
    const first = await h.store.get<PolicyMailbox>(policyMailboxKey(user));
    expect(first?.notices.length).toBeGreaterThan(0);
    expect(first?.notices.length).toBeLessThan(3);
    expect(
      (await h.store.get<PolicyNotificationProgress>('notification:progress'))
        ?.lastCompletedAt,
    ).toBeUndefined();
    expect(
      (await h.store.get<PolicyNotificationProgress>('notification:progress'))
        ?.active?.after,
    ).toBe('a');
    await h.store.update<PolicyMailbox>(policyMailboxKey(user), (box) => {
      box!.notices[0].readAt = '2026-09-30T01:00:00Z';
      return box!;
    });
    h.ports.getActor.mockImplementation(async (id) => h.actors.get(id) ?? null);
    await refreshPolicyNotifications(h.ports);
    const last = await h.store.get<PolicyMailbox>(policyMailboxKey(user));
    expect(last?.notices).toHaveLength(3);
    expect(last?.notices[0].id).toBe(first?.notices[0].id);
    expect(last?.notices[0].readAt).toBe('2026-09-30T01:00:00Z');
  });
  it('preserves an oversized legacy mailbox verbatim and exposes maintenance without starving later users', async () => {
    const h = harness();
    const large = await h.add('large');
    const small = await h.add('small');
    const original = {
      ...emptyPolicyMailbox(large),
      legacyHistory: '保留'.repeat(400_000),
    };
    await h.store.update(policyMailboxKey(large), () => original);
    const get = vi.spyOn(h.store, 'get');
    await refreshPolicyNotifications(h.ports);
    expect(get).not.toHaveBeenCalledWith(policyMailboxKey(large));
    expect(await h.store.get(policyMailboxKey(large))).toEqual(original);
    expect(
      await h.store.get(policyNotificationHealthKey(policyMailboxKey(large))),
    ).toMatchObject({ status: 'needs-maintenance' });
    expect(
      (await h.store.get<PolicyMailbox>(policyMailboxKey(small)))?.notices,
    ).toHaveLength(1);
    expect(await h.store.get('notification:progress')).toMatchObject({
      status: 'needs-maintenance',
    });
    expect(
      (await h.store.get<PolicyNotificationProgress>('notification:progress'))
        ?.lastCompletedAt,
    ).toBeUndefined();
  });
  it('rechecks enablement after reading a document before committing a notification', async () => {
    const h = harness();
    const user = await h.add('user');
    h.ports.workspace
      .mockResolvedValueOnce({ enabled: true, region: { country: 'CN' } })
      .mockResolvedValue({ enabled: false, region: { country: 'CN' } });
    await refreshPolicyNotifications(h.ports);
    expect(
      (await h.store.get<PolicyMailbox>(policyMailboxKey(user)))?.notices,
    ).toEqual([]);
  });
  it('does not let concurrent ticks overwrite the durable cursor or duplicate events', async () => {
    const h = harness();
    const user = await h.add('user');
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ports.getActor.mockImplementationOnce(async () => {
      await wait;
      return user;
    });
    const first = refreshPolicyNotifications(h.ports);
    await vi.waitFor(() => expect(h.ports.getActor).toHaveBeenCalled());
    await refreshPolicyNotifications(h.ports);
    expect(h.ports.getActor).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(
      (await h.store.get<PolicyMailbox>(policyMailboxKey(user)))?.notices,
    ).toHaveLength(1);
  });
  it('observes earlier newly inserted watches and later revisions on the next sweep without losing old readAt', async () => {
    const h = harness();
    const user = await h.add('user', ['b']);
    await refreshPolicyNotifications(h.ports);
    await h.store.update<PolicyMailbox>(policyMailboxKey(user), (box) => {
      box!.notices[0].readAt = 'read-before-new-revision';
      return box!;
    });
    await h.store.update('document:a', () => ({ ...doc, id: 'a' }));
    await watchPolicy(h.store, user, { ...doc, id: 'a' }, true);
    await h.store.update('document:b', () => ({
      ...doc,
      id: 'b',
      contentHash: 'v2',
      version: 2,
    }));
    await refreshPolicyNotifications(h.ports);
    await refreshPolicyNotifications(h.ports);
    const box = await h.store.get<PolicyMailbox>(policyMailboxKey(user));
    expect(
      box?.notices.map((notice) => [notice.policyId, notice.kind]),
    ).toEqual([
      ['b', 'deadline'],
      ['a', 'deadline'],
      ['b', 'changed'],
    ]);
    expect(box?.notices[0].readAt).toBe('read-before-new-revision');
  });
  it('caps watched document work at 128 and resumes the remainder without accumulating cache IDs', async () => {
    const h = harness();
    await h.add(
      'first',
      Array.from(
        { length: 100 },
        (_, i) => `p-${i.toString().padStart(3, '0')}`,
      ),
    );
    await h.add(
      'second',
      Array.from(
        { length: 100 },
        (_, i) => `p-${i.toString().padStart(3, '0')}`,
      ),
    );
    const reads = vi.spyOn(h.store, 'getBounded');
    await refreshPolicyNotifications(h.ports);
    expect(
      reads.mock.calls.filter(([key]) => key.startsWith('document:')),
    ).toHaveLength(128);
    expect(
      (await h.store.get<PolicyNotificationProgress>('notification:progress'))
        ?.active?.after,
    ).toBe('p-027');
    reads.mockClear();
    await refreshPolicyNotifications(h.ports);
    expect(
      reads.mock.calls.filter(([key]) => key.startsWith('document:')),
    ).toHaveLength(72);
    for (const user of h.actors.values())
      expect(
        (await h.store.get<PolicyMailbox>(policyMailboxKey(user)))?.notices,
      ).toHaveLength(100);
  });
  it('refuses a notice that would cross the byte guard without mutating or truncating history', async () => {
    const h = harness();
    const user = await h.add('user');
    const key = policyMailboxKey(user);
    const box = (await h.store.get<PolicyMailbox>(key))!;
    const padding =
      1024 * 1024 -
      Buffer.byteLength(JSON.stringify({ ...box, legacyHistory: '' })) -
      10;
    const original = { ...box, legacyHistory: 'x'.repeat(padding) };
    await h.store.update(key, () => original);
    await refreshPolicyNotifications(h.ports);
    expect(await h.store.get(key)).toEqual(original);
    expect(await h.store.get(policyNotificationHealthKey(key))).toMatchObject({
      status: 'needs-maintenance',
    });
  });
  it('replays safely if checkpoint persistence fails after the atomic notice write', async () => {
    const h = harness();
    const user = await h.add('user');
    const key = policyMailboxKey(user);
    const original = h.store.update.bind(h.store);
    let wroteMailbox = false;
    let failed = false;
    vi.spyOn(h.store, 'update').mockImplementation(
      async (recordKey, change, options) => {
        if (recordKey === 'notification:progress' && wroteMailbox && !failed) {
          failed = true;
          throw new Error('checkpoint IO failed');
        }
        const result = await original(recordKey, change, options);
        if (recordKey === key) wroteMailbox = true;
        return result;
      },
    );
    await expect(refreshPolicyNotifications(h.ports)).rejects.toThrow(
      'checkpoint IO failed',
    );
    expect(
      (await h.store.get<PolicyNotificationProgress>('notification:progress'))
        ?.active?.after,
    ).toBeUndefined();
    await refreshPolicyNotifications(h.ports);
    expect((await h.store.get<PolicyMailbox>(key))?.notices).toHaveLength(1);
  });
});
