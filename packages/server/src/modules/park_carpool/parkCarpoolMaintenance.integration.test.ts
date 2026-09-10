import { carpoolTestConfig } from './parkCarpoolTestSupport.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  sqliteHarness,
  postgresHarness,
  publish,
  fixed,
} from './parkCarpoolTestSupport.js';
import { createParkCarpoolService, type ParkCarpoolStore } from './parkCarpoolService.js';
import { CarpoolMaintenanceDeferred } from './parkCarpoolRetention.js';
import { emptyCarpoolWorkflow } from './parkCarpoolWorkflow.js';
const options = { now: fixed.toISOString(), positionRetentionHours: 24, communicationRetentionDays: 30 };
const mapProvider = { configured: true, searchPlaces: async () => [], planDrivingRoute: async (a: typeof publish.origin.coordinate, b: typeof a) => ({ provider: 'fixture', distanceMeters: 8500, durationSeconds: 1200, polyline: [a, b] }) };
for (const [name, factory] of [['SQLite', sqliteHarness], ['PostgreSQL', postgresHarness]] as const) {
  const test = it.skipIf(name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1');
  test(`${name}: pages publications and workflows, preserving unchanged rows`, async () => {
    const h = await factory();
    try {
      const service = createParkCarpoolService({ config: carpoolTestConfig, store: h.store, now: () => fixed, createId: id => `intent-${id}`, mapProvider });
      const receipt = await service.publishIntent('a', publish);
      const keys = Array.from({ length: 65 }, (_, i) => `key-${i}`);
      for (const key of keys) await h.store.publications!.writePublication('a', key, { version: 1, hash: key, leaseId: key, leaseUntil: 0, receipt }, null);
      const parks = Array.from({ length: 9 }, (_, i) => `park-${i}`);
      for (const park of parks) await h.store.transactWorkflow!(park, 'a', ctx => { ctx.state.notices.push({ id: park, accountId: 'a', type: 'test', subjectId: park, text: 'expired fixture', createdAt: '2020-01-01T00:00:00Z' }); });
      let remaining = 65;
      for (let tick = 0; tick < 4; tick++) {
        const before = await Promise.all(parks.map(id => h.workflowCipher(id)));
        const result = await h.store.maintain!({ ...options, now: '2026-09-12T00:00:00Z' });
        expect(result.scanned?.publications).toBeLessThanOrEqual(32);
        expect(result.scanned?.workflows).toBeLessThanOrEqual(4);
        const after = await Promise.all(parks.map(id => h.workflowCipher(id)));
        expect(after.filter((value, i) => value !== before[i]).length).toBeLessThanOrEqual(4);
        const current = (await Promise.all(keys.map(key => h.store.publications!.readPublication('a', key)))).filter(Boolean).length;
        expect(remaining - current).toBeLessThanOrEqual(32); remaining = current;
      }
      expect(remaining).toBe(0);
      for (const park of parks) expect(await h.store.transactWorkflow!(park, 'a', ctx => ctx.state.notices.length)).toBe(0);
    } finally { await h.close(); }
  }, 30_000);
  test(`${name}: rollback keeps all page cursors and workflow references survive intent deletion until their page`, async () => {
    const h = await factory();
    try {
      const service = createParkCarpoolService({ config: carpoolTestConfig, store: h.store, now: () => fixed, createId: id => `intent-${id}`, mapProvider });
      const template = await service.publishIntent('a', publish);
      await service.publishIntent('b', publish);
      await service.executeWorkflow('a', { type: 'request', kind: 'text', targetIntentId: 'intent-b', firstMessage: 'retention fixture' });
      const ids = Array.from({ length: 8 }, (_, i) => `extra-${i}`);
      await h.seedAccounts(ids);
      for (const id of ids) await h.store.saveIntent({ ...template, id, accountId: id, organizationId: 'org-b', requestKey: undefined, requestHash: undefined });
      for (let i = 0; i < 9; i++) await h.store.transactWorkflow!(`park-${i}`, 'a', ctx => { ctx.state.notices.push({ id: 'old', accountId: 'a', type: 'test', subjectId: 'old', text: 'old', createdAt: '2020-01-01' }); });
      await h.failMaintenance(true);
      await expect(h.store.maintain!({ ...options, now: '2026-09-12T00:00:00Z' })).rejects.toThrow('injected maintenance failure');
      expect(await h.store.getIntent('extra-0')).not.toBeNull();
      await h.failMaintenance(false);
      expect((await h.store.maintain!({ ...options, now: '2026-09-12T00:00:00Z' })).deletedPositions).toBe(4);
      expect(await h.store.getIntent('extra-0')).toBeNull();
      await h.disable();
      for (let i = 0; i < 6; i++) await h.store.maintain!(options);
      expect(await h.store.getIntent('a')).toBeNull();
      expect(await h.store.transactWorkflow!('park-a', 'b', ctx => ctx.state.requests.length)).toBe(0);
    } finally { await h.close(); }
  }, 30_000);
  test(`${name}: background defers oversized ciphertext without decoding it and exposes the reason`, async () => {
    const h = await factory();
    try {
      const service = createParkCarpoolService({ config: carpoolTestConfig, store: h.store, now: () => fixed, createId: id => `intent-${id}`, mapProvider });
      await service.publishIntent('a', publish);
      await service.getWorkflow('a');
      const original = await h.workflowCipher();
      const oversized = 'x'.repeat(1024 * 1024 + 1);
      await h.setWorkflowCipher('park-a', oversized);
      const result = await service.maintain();
      expect(result.deferred).toContainEqual(expect.objectContaining({ parkId: 'park-a', reason: 'workflow_bytes' }));
      expect(await h.workflowCipher()).toBe(oversized);
      await h.setWorkflowCipher('park-a', original);
      expect((await service.getState('a')).backgroundRefresh).toMatchObject({ status: 'deferred', reason: 'workflow_bytes' });
      await service.maintain();
      expect((await service.getState('a')).backgroundRefresh).toBeUndefined();
    } finally { await h.close(); }
  }, 30_000);
  test(`${name}: every active account across non-account-ordered pages gets background refresh`, async () => {
    const h = await factory();
    try {
      const touched = new Set<string>();
      let observing = false;
      const store = { ...h.store, getIntent: async (...args: Parameters<typeof h.store.getIntent>) => { if (observing) touched.add(args[0]); return h.store.getIntent(...args); } };
      const service = createParkCarpoolService({ config: carpoolTestConfig, store, now: () => fixed, createId: id => `intent-${id}`, mapProvider });
      const template = await service.publishIntent('a', publish);
      const ids = Array.from({ length: 35 }, (_, i) => `active-${String(i).padStart(2, '0')}`);
      await h.seedAccounts(ids);
      for (const [i, id] of ids.entries()) await h.store.saveIntent({ ...template, id: `id-${String(35 - i).padStart(2, '0')}`, accountId: id, organizationId: 'org-b', requestKey: undefined, requestHash: undefined });
      observing = true;
      for (let i = 0; i < 10; i++) expect((await service.maintain()).failures).toBe(0);
      expect([...touched].sort()).toEqual(['a', ...ids].sort());
      let deleted = 0;
      for (let i = 0; i < 10; i++) {
        const result = await h.store.maintain!({ ...options, now: '2026-09-12T00:00:00Z' });
        expect(result.deletedPositions).toBeLessThanOrEqual(4); deleted += result.deletedPositions;
      }
      expect(deleted).toBe(36);
      expect(await h.store.getIntent(ids.at(-1)!)).toBeNull();
    } finally { await h.close(); }
  }, 30_000);
  test(`${name}: actual background transaction rejects a concurrent oversized population without reconciliation`, async () => {
    const h = await factory();
    try {
      const initial = createParkCarpoolService({ config: carpoolTestConfig, store: h.store, now: () => fixed, createId: id => `intent-${id}`, mapProvider });
      const template = await initial.publishIntent('a', publish);
      await initial.getWorkflow('a');
      const before = await h.workflowCipher();
      const ids = Array.from({ length: 200 }, (_, i) => `overflow-${i}`);
      await h.seedAccounts(ids);
      let injected = false;
      const store = { ...h.store, transactWorkflow: async <T>(parkId: string, actorId: string, operation: Parameters<NonNullable<typeof h.store.transactWorkflow>>[2], maintenance?: boolean) => {
        if (maintenance && !injected) {
          injected = true;
          for (const id of ids) await h.store.saveIntent({ ...template, id, accountId: id, organizationId: 'org-b', requestKey: undefined, requestHash: undefined });
        }
        return h.store.transactWorkflow!(parkId, actorId, operation, maintenance) as Promise<T>;
      } };
      const service = createParkCarpoolService({ config: carpoolTestConfig, store, now: () => fixed, createId: id => `intent-${id}`, mapProvider });
      expect((await service.maintain()).deferred).toContainEqual({ parkId: 'park-a', reason: 'park_intents' });
      expect(await h.workflowCipher()).toBe(before);
      let ran = false;
      await expect(h.store.transactWorkflow!('park-a', 'a', () => { ran = true; }, true)).rejects.toThrow('park_intents');
      expect(ran).toBe(false);
      expect((await service.getState('a')).backgroundRefresh?.reason).toBe('park_intents');
    } finally { await h.close(); }
  }, 30_000);
  test(`${name}: same-park organization changes revoke workflow facts even after the intent was removed`, async () => {
    const h = await factory();
    try {
      const service = createParkCarpoolService({ config: carpoolTestConfig, store: h.store, now: () => fixed, createId: id => `intent-${id}`, mapProvider });
      await service.publishIntent('a', publish); await service.publishIntent('b', publish);
      await service.executeWorkflow('a', { type: 'request', kind: 'text', targetIntentId: 'intent-b', firstMessage: 'scope fixture' });
      for (let i = 0; i < 4; i++) await h.store.transactWorkflow!(`park-${i}`, 'a', () => undefined);
      await h.moveOrganization();
      await h.store.maintain!(options);
      expect(await h.store.getIntent('a')).toBeNull();
      await h.store.maintain!(options);
      expect(await h.store.transactWorkflow!('park-a', 'b', ctx => ctx.state.requests.length)).toBe(0);
    } finally { await h.close(); }
  }, 30_000);
  test(`${name}: bounds relevant devices and workflow principals without blocking unrelated accounts`, async () => {
    const h = await factory();
    try {
      const service = createParkCarpoolService({ config: carpoolTestConfig, store: h.store, now: () => fixed, createId: id => `intent-${id}`, mapProvider });
      await service.publishIntent('a', publish); await service.publishIntent('b', publish);
      await h.approveDevices(); await h.seedDevices('c', 260);
      expect((await service.maintain()).deferred).toEqual([]);
      const before = await h.workflowCipher();
      await h.seedDevices('b', 260);
      expect((await service.maintain()).deferred).toContainEqual({ parkId: 'park-a', reason: 'approved_devices' });
      expect(await h.workflowCipher()).toBe(before);
      await h.store.transactWorkflow!('park-a', 'a', ctx => { for (let i = 0; i < 257; i++) ctx.state.notices.push({ id: `ref-${i}`, accountId: `ref-${i}`, type: 'test', subjectId: 'ref', text: 'ref', createdAt: fixed.toISOString() }); });
      const oversized = await h.workflowCipher();
      expect((await h.store.maintain!(options)).deferred).toContainEqual({ parkId: 'park-a', reason: 'workflow_principals' });
      expect(await h.workflowCipher()).toBe(oversized);
    } finally { await h.close(); }
  }, 30_000);
}
it.skipIf(process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1')('PostgreSQL: background and foreground intent locks share one total order beyond the workflow page', async () => {
  const h = await postgresHarness();
  const client = await h.pool.connect();
  let running: Promise<unknown> | undefined;
  try {
    const service = createParkCarpoolService({ config: carpoolTestConfig, store: h.store, now: () => fixed, createId: id => id === 'a' ? 'z-intent' : 'a-intent', mapProvider });
    await service.publishIntent('a', publish); await service.publishIntent('b', publish);
    for (let i = 0; i < 4; i++) await h.store.transactWorkflow!(`park-${i}`, 'a', () => undefined);
    await h.store.transactWorkflow!('park-a', 'a', () => undefined);
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='2s'");
    await client.query("SELECT park_id FROM park_carpool_workflow WHERE park_id='park-a' FOR UPDATE");
    await client.query("SELECT resource_id FROM enterprise_business_records WHERE resource_type='carpool_intent' AND resource_id='a-intent' FOR SHARE");
    running = h.store.maintain!(options).then(value => ({ value }), error => ({ error }));
    let waiting = false;
    for (let i = 0; i < 30; i++) {
      waiting = (await h.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%carpool_intent%' LIMIT 1")).rows.length > 0;
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await client.query("SELECT resource_id FROM enterprise_business_records WHERE resource_type='carpool_intent' AND resource_id='z-intent' FOR SHARE");
    await client.query('COMMIT');
    expect(await running).toHaveProperty('value');
  } finally { await client.query('ROLLBACK'); client.release(); await running; await h.close(); }
}, 30_000);
it('background status cache is bounded, expires, and clears after successful refresh', async () => {
  let id = 'account-0'; let clock = fixed; let defer = true;
  const actor = (accountId: string) => ({ accountId, organizationId: 'org', organizationName: 'org', displayName: accountId, parkId: 'park', active: true, parkServiceEnabled: true });
  const store: ParkCarpoolStore = {
    maintain: async () => ({ accountIds: [id], deletedPositions: 0 }),
    getPrincipal: async accountId => actor(accountId), getIntent: async () => null,
    listActiveIntents: async () => [], saveIntent: async value => value, stopIntent: async () => null,
    transactWorkflow: async (park, accountId, operation, maintenance) => {
      if (maintenance && defer) throw new CarpoolMaintenanceDeferred(park, 'fixture');
      return operation({ state: emptyCarpoolWorkflow(), actor: actor(accountId), intents: [], devices: [], stoppedIntentIds: [] });
    },
  };
  const service = createParkCarpoolService({ store, now: () => clock, createId: value => value, mapProvider });
  for (let i = 0; i < 1030; i++) { id = `account-${i}`; await service.maintain(); }
  expect((await service.getState('account-0')).backgroundRefresh).toBeUndefined();
  expect((await service.getState(id)).backgroundRefresh?.reason).toBe('fixture');
  defer = false; await service.maintain();
  expect((await service.getState(id)).backgroundRefresh).toBeUndefined();
  defer = true; await service.maintain();
  clock = new Date(fixed.getTime() + 86400_001);
  expect((await service.getState(id)).backgroundRefresh).toBeUndefined();
});
for (const [name, factory] of [['SQLite', sqliteHarness], ['PostgreSQL', postgresHarness]] as const) {
  it.skipIf(name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1')(
    `${name}: does not rewrite unchanged workflow ciphertext during maintenance`, async () => {
      const h = await factory();
      try {
        await h.store.transactWorkflow!('park-a', 'a', () => undefined);
        const before = await h.workflowCipher();
        const options = { now: fixed.toISOString(), positionRetentionHours: 24, communicationRetentionDays: 30 };
        await h.store.maintain!(options);
        expect(await h.workflowCipher()).toBe(before);
        await h.store.maintain!(options);
        expect(await h.workflowCipher()).toBe(before);
      } finally { await h.close(); }
    }, 30_000,
  );
}
for (const [name, factory] of [
  ['SQLite', sqliteHarness],
  ['PostgreSQL', postgresHarness],
] as const)
  it.skipIf(
    name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1',
  )(
    `${name}: expires without user reads, cleans precise positions and deletes own workflow facts`,
    async () => {
      const h = await factory();
      let clock = fixed;
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => clock,
        createId: (id, date) => `intent-${id}-${date}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-maintenance',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.publishIntent('a', publish);
        await service.publishIntent('b', publish);
        clock = new Date(fixed.getTime() + 7 * 60 * 60_000);
        expect((await service.getState('a')).searchStatus).toBe(
          'needs_confirmation',
        );
        await service.confirmIntent('a', 'intent-a-2026-09-08');
        expect((await service.getState('a')).searchStatus).toBe('searching');
        clock = fixed;
        await service.executeWorkflow('a', {
          type: 'request',
          kind: 'text',
          targetIntentId: 'intent-b-2026-09-08',
          firstMessage: '请求应在删除后消失',
        });
        await service.deleteData('a');
        expect(await h.store.getIntent('a')).toBeNull();
        expect((await service.getWorkflow('b')).requests).toHaveLength(0);
        let entered!: () => void;
        const planning = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const pendingService = createParkCarpoolService({ config: carpoolTestConfig,
          store: h.store,
          now: () => clock,
          createId: (id, date) => `intent-${id}-${date}`,
          mapProvider: {
            configured: true,
            searchPlaces: async () => [],
            planDrivingRoute: async (a, b) => {
              entered();
              await gate;
              return {
                provider: 'synthetic-pending',
                distanceMeters: 8500,
                durationSeconds: 1200,
                polyline: [a, b],
              };
            },
          },
        });
        const result = pendingService
          .publishIntent('a', { ...publish, requestKey: undefined })
          .then(
            () => null,
            (error) => error,
          );
        await planning;
        await service.deleteData('a');
        release();
        expect(await result).toBeInstanceOf(Error);
        expect(await h.store.getIntent('a')).toBeNull();
        clock = new Date('2026-09-08T12:00:00Z');
        await service.maintain();
        expect((await h.store.getIntent('b'))?.status).toBe('expired');
        expect(
          (await service.getWorkflow('b')).notices.some(
            (n) => n.type === 'intent_expired',
          ),
        ).toBe(true);
        clock = new Date('2026-09-10T12:00:00Z');
        await service.maintain();
        expect(await h.store.getIntent('b')).toBeNull();
      } finally {
        await h.close();
      }
    },
    30_000,
  );

for (const [name, factory] of [
  ['SQLite', sqliteHarness],
  ['PostgreSQL', postgresHarness],
] as const)
  it.skipIf(
    name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1',
  )(
    `${name}: moving parks prunes old scope without deleting new valid intent`,
    async () => {
      const h = await factory();
      let clock = new Date('2026-09-07T00:00:00Z');
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => clock,
        createId: (id, date) => `intent-${id}-${date}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-maintenance',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.publishIntent('a', {
          ...publish,
          travelDate: '2026-09-07',
          departureTime: '2026-09-07T18:30:00+08:00',
          requestKey: 'old-park-publication',
        });
        await h.moveToParkB();
        clock = fixed;
        const current = await service.publishIntent('a', {
          ...publish,
          requestKey: 'new-park-publication',
        });
        await service.maintain();
        expect((await h.store.getIntent('a', '2026-09-08'))?.parkId).toBe(
          'park-b',
        );
        expect(await h.store.getIntent('a', '2026-09-07')).toBeNull();
        expect(
          await service.publishIntent('a', {
            ...publish,
            requestKey: 'new-park-publication',
          }),
        ).toEqual(current);
      } finally {
        await h.close();
      }
    },
    30_000,
  );

it('cancels maintenance before candidate effects after ownership is lost during a database read', async () => {
 const h=await sqliteHarness();
 const controller=new AbortController();
 let pause=false;
 let entered!:()=>void;let release!:()=>void;
 const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const original=h.store.listIntentPage!.bind(h.store);
 const store={...h.store,listIntentPage:async(...args:Parameters<typeof original>)=>{
  const result=await original(...args);if(pause){entered();await gate;}return result;
 }};
 const service=createParkCarpoolService({config:carpoolTestConfig,store,now:()=>fixed,createId:id=>`intent-${id}`,mapProvider:{configured:true,searchPlaces:async()=>[],planDrivingRoute:async(a,b)=>({provider:'synthetic',distanceMeters:8500,durationSeconds:1200,polyline:[a,b]})}});
 try {
  await service.publishIntent('a',publish);await service.publishIntent('b',publish);
  const before=(await service.getWorkflow('a')).metrics;
  pause=true;
  const running=service.maintain(controller.signal).then(()=>null,error=>error);
  await waiting;controller.abort();release();
  expect(await running).toBeInstanceOf(Error);
  const after=(await service.getWorkflow('a')).metrics;
  expect(after?.averageCandidates).toEqual(before?.averageCandidates);
  expect((await service.getWorkflow('a')).notices.filter(n=>n.type==='new_match')).toHaveLength(0);
  pause=false;await Promise.all([service.maintain(),service.maintain()]);
  expect((await service.getWorkflow('a')).metrics?.averageCandidates).toEqual(before?.averageCandidates);
  expect((await service.getWorkflow('a')).notices.filter(n=>n.type==='new_match')).toHaveLength(1);
 }finally{release();await h.close();}
});
