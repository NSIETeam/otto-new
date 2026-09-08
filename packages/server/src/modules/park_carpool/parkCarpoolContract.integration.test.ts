import { carpoolTestConfig } from './parkCarpoolTestSupport.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  createParkCarpoolService,
  type ParkCarpoolStore,
} from './parkCarpoolService.js';
import {
  fixed,
  publish,
  sqliteHarness,
  postgresHarness,
} from './parkCarpoolTestSupport.js';

describe('real database carpool contract (synthetic map only)', () => {
  for (const backend of ['sqlite', 'postgres'] as const) {
    it.skipIf(
      backend === 'postgres' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1',
    )(
      `${backend}: publish, privacy, replay, concurrent updates, stop, identity revocation`,
      async () => {
        const harness = await (backend === 'sqlite'
          ? sqliteHarness()
          : postgresHarness());
        let planned = 0;
        const store: ParkCarpoolStore = harness.store;
        const service = createParkCarpoolService({ config: carpoolTestConfig,
          store,
          now: () => fixed,
          createId: (id) => `intent-${id}`,
          mapProvider: {
            configured: true,
            searchPlaces: async () => [],
            planDrivingRoute: async (origin, destination) => {
              planned += 1;
              return {
                provider: 'synthetic-contract-fixture',
                distanceMeters: 8500,
                durationSeconds: 1200,
                polyline: [origin, destination],
              };
            },
          },
        });
        try {
          const first = await service.publishIntent('a', publish);
          expect(first.version).toBe(1);
          expect((await service.publishIntent('a', publish)).id).toBe(first.id);
          expect(planned).toBe(1);
          await expect(
            service.publishIntent('a', { ...publish, flexibleMinutes: 15 }),
          ).rejects.toThrow(/请求标识/);
          await service.publishIntent('b', publish);
          const state = await service.getState('a');
          expect(state.matches).toHaveLength(1);
          expect(JSON.stringify(state.matches)).not.toContain('二〇一');
          const updates = await Promise.allSettled(
            [10, 20].map((flexibleMinutes) =>
              service.publishIntent('a', {
                ...publish,
                requestKey: `request-update-${flexibleMinutes}`,
                flexibleMinutes,
                expectedVersion: 1,
              }),
            ),
          );
          expect(
            updates.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          expect((await service.publishIntent('a', publish)).version).toBe(1);
          const countBefore = planned;
          const sameRequest = {
            ...publish,
            requestKey: 'same-concurrent-request',
            flexibleMinutes: 25,
          };
          const identical = await Promise.allSettled([
            service.publishIntent('a', sameRequest),
            service.publishIntent('a', sameRequest),
          ]);
          expect(
            identical.filter((result) => result.status === 'fulfilled').length,
          ).toBeGreaterThanOrEqual(1);
          await service.publishIntent('a', sameRequest);
          expect(planned - countBefore).toBe(1);
          const current = (await store.getIntent('a'))!;
          await service.stopIntent('a', first.id);
          await service.stopIntent('a', first.id);
          await expect(
            store.saveIntent({ ...current, status: 'active' }, current.version),
          ).rejects.toThrow(/更新/);
          await expect(
            service.publishIntent('a', {
              ...publish,
              requestKey: 'invalid-date-request',
              departureTime: '2026-09-09T18:30:00+08:00',
            }),
          ).rejects.toThrow(/日期/);
          await expect(service.stopIntent('b', first.id)).rejects.toThrow(
            /无权/,
          );
          await harness.failReceipts();
          const beforeFailure = (await store.getIntent('b'))!;
          await expect(
            service.publishIntent('b', {
              ...publish,
              requestKey: 'receipt-failure-request',
              flexibleMinutes: 5,
            }),
          ).rejects.toThrow(/injected receipt failure/);
          expect((await store.getIntent('b'))?.version).toBe(
            beforeFailure.version,
          );
          expect((await store.getIntent('b'))?.flexibleMinutes).toBe(
            beforeFailure.flexibleMinutes,
          );
          await harness.disable();
          await expect(service.getState('a')).rejects.toThrow(/账号/);
        } finally {
          await harness.close();
        }
      },
      60_000,
    );
  }
});

for (const [name, factory] of [
  ['SQLite', sqliteHarness],
  ['PostgreSQL', postgresHarness],
] as const) {
  it.skipIf(
    name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1',
  )(
    `${name}: scans beyond 200 candidates before ranking/filtering and pages without duplicates`,
    async () => {
      const h = await factory();
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-pagination',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        const ids = Array.from(
          { length: 205 },
          (_, i) => `person-${String(i).padStart(3, '0')}`,
        );
        await h.seedAccounts(ids);
        const base = await service.publishIntent('a', {
          ...publish,
          travelOptions: ['rider', 'shared_taxi'],
        });
        for (const [index, id] of ids.entries())
          await h.store.saveIntent({
            ...base,
            id: `intent-${id}`,
            accountId: id,
            organizationId: 'org-b',
            displayName: id,
            travelOptions: index === 204 ? ['driver'] : ['shared_taxi'],
            departureTime:
              index === 204 ? base.departureTime : '2026-09-08T10:40:00.000Z',
          });
        const first = await service.getState('a');
        expect(first.resultPage?.total).toBe(205);
        expect(first.matches).toHaveLength(50);
        expect(first.matches[0]!.intentId).toBe('intent-person-204');
        const found = new Set(first.matches.map((m) => m.intentId));
        let cursor = first.resultPage?.nextCursor;
        while (cursor) {
          const page = await service.getState('a', { cursor });
          for (const m of page.matches) {
            expect(found.has(m.intentId)).toBe(false);
            found.add(m.intentId);
          }
          cursor = page.resultPage?.nextCursor;
        }
        expect(found.size).toBe(205);
        const filtered = await service.getState('a', {
          filter: 'current_rides_candidate_vehicle',
        });
        expect(filtered.matches.map((m) => m.intentId)).toEqual([
          'intent-person-204',
        ]);
        expect(
          (await service.routePreview('a', 'intent-person-000')).segments
            .length,
        ).toBeGreaterThan(0);
        await service.stopIntent('person-204', 'intent-person-204');
        await expect(
          service.getState('a', { cursor: first.resultPage!.nextCursor }),
        ).rejects.toThrow(/更新/);
      } finally {
        await h.close();
      }
    },
    30000,
  );
}

for(const [name,factory] of [['SQLite',sqliteHarness],['PostgreSQL',postgresHarness]] as const) {
 it.skipIf(name==='PostgreSQL'&&process.env.OTTO_CARPOOL_POSTGRES_TEST!=='1')(`${name}: evaluates group invitations across multiple planning batches`,async()=>{
  const h=await factory();const service=createParkCarpoolService({ config: carpoolTestConfig,store:h.store,now:()=>fixed,createId:id=>`intent-${id}`,mapProvider:{configured:true,searchPlaces:async()=>[],planDrivingRoute:async(a,b)=>({provider:'synthetic-group-batches',distanceMeters:8500,durationSeconds:1200,polyline:[a,b]})}});
  try{
   const ids=Array.from({length:30},(_,i)=>`external-${i}`);await h.seedAccounts(ids);
   const base=await service.publishIntent('a',publish);await service.publishIntent('b',publish);
   for(const id of ids)await h.store.saveIntent({...base,id:`intent-${id}`,accountId:id,organizationId:'org-b',displayName:id});
   await service.executeWorkflow('a',{type:'request',kind:'carpool_invite',targetIntentId:'intent-b',travelMode:'shared_taxi',firstMessage:'一起同行'});
   await service.executeWorkflow('b',{type:'resolve',requestId:(await service.getWorkflow('b')).requests[0]!.id,action:'accept'});
   const result=await service.getState('a');expect(result.matches).toHaveLength(0);expect(result.groupMatches).toHaveLength(30);expect(new Set(result.groupMatches?.map(match=>match.intentId)).size).toBe(30);
  }finally{await h.close();}
 },30000);
}
