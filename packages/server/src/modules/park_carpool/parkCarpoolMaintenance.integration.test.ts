/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  sqliteHarness,
  postgresHarness,
  publish,
  fixed,
} from './parkCarpoolTestSupport.js';
import { createParkCarpoolService } from './parkCarpoolService.js';
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
      const service = createParkCarpoolService({
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
        const pendingService = createParkCarpoolService({
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
      const service = createParkCarpoolService({
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
