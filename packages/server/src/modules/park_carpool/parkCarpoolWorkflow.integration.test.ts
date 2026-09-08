import { carpoolTestConfig } from './parkCarpoolTestSupport.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { createParkCarpoolService } from './parkCarpoolService.js';
import { createCarpoolWorkflow } from './parkCarpoolWorkflow.js';
import {
  sqliteHarness,
  postgresHarness,
  publish,
  fixed,
} from './parkCarpoolTestSupport.js';

for (const [name, factory] of [
  ['SQLite', sqliteHarness],
  ['PostgreSQL', postgresHarness],
] as const) {
  describe.skipIf(
    name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1',
  )(`${name} persistent carpool requests`, () => {
    it('invalidates outstanding pair invitations on joining and allows blocking a fellow group member without a direct request', async () => {
      const h = await factory();
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-test',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.executeWorkflow('a', { type: 'record_open' });
        for (const id of ['a', 'b', 'c'])
          await service.publishIntent(id, publish);
        for (const target of ['b', 'c'])
          await service.executeWorkflow('a', {
            type: 'request',
            kind: 'carpool_invite',
            targetIntentId: `intent-${target}`,
            travelMode: 'shared_taxi',
            firstMessage: '一起同行',
          });
        await service.executeWorkflow('b', {
          type: 'resolve',
          requestId: (await service.getWorkflow('b')).requests[0]!.id,
          action: 'accept',
        });
        expect((await service.getWorkflow('c')).requests[0]!.status).toBe(
          'expired',
        );
        const ownGroup = (await service.getWorkflow('b')).myGroup!;
        expect(
          (await service.routePreview('b', 'intent-b', ownGroup.id)).segments
            .length,
        ).toBeGreaterThan(0);
        await expect(
          service.routePreview('c', 'intent-c', ownGroup.id),
        ).rejects.toThrow(/无权/);
        await service.executeWorkflow('b', {
          type: 'availability',
          accepting: false,
        });
        expect(
          (await service.routePreview('b', 'intent-b', ownGroup.id)).segments
            .length,
        ).toBeGreaterThan(0);
        await service.executeWorkflow('b', {
          type: 'availability',
          accepting: true,
        });
        await service.executeWorkflow('a', {
          type: 'request',
          kind: 'group_invite',
          targetIntentId: 'intent-c',
          firstMessage: '加入本组',
        });
        await service.executeWorkflow('c', {
          type: 'resolve',
          requestId: (await service.getWorkflow('c')).requests.find(
            (r) => r.status === 'pending',
          )!.id,
          action: 'accept',
        });
        const before = (await service.getWorkflow('b')).conversations.find(
          (c) => c.kind === 'group',
        )!;
        await createCarpoolWorkflow({ config: carpoolTestConfig,
          store: h.store,
          now: () => fixed,
        }).withContext('a', (ctx) => {
          ctx.state.transport = {
            packages: [],
            sessions: [],
            reads: [],
            events: [
              {
                id: 'reported-event',
                sequence: 1,
                conversationId: before.id,
                generation: before.generation,
                sender: 'scope/org-b/c/device-c',
                groupId: 'crypto-group',
                epoch: 1,
                ciphertext: 'ciphertext-evidence',
                createdAt: fixed.toISOString(),
              },
            ],
          };
        });
        await expect(
          service.executeWorkflow('d', {
            type: 'report_message',
            conversationId: before.id,
            eventId: 'reported-event',
            plaintext: '不应看到',
            reason: '测试',
          }),
        ).rejects.toThrow(/无权/);
        const reported = await service.executeWorkflow('b', {
          type: 'report_message',
          conversationId: before.id,
          eventId: 'reported-event',
          plaintext: '测试消息内容',
          reason: '群内骚扰',
        });
        expect(reported.reports[0]).toMatchObject({
          target: 'c',
          evidence: {
            firstMessage: '测试消息内容',
            kind: 'chat_message',
            source: 'reporter_submission',
          },
        });
        await expect(
          service.executeWorkflow('b', { type: 'block', targetAccountId: 'c' }),
        ).rejects.toThrow(/确认退出/);
        const after = await service.executeWorkflow('b', {
          type: 'block',
          targetAccountId: 'c',
          leaveSharedGroup: true,
        });
        expect(after.ownBlockedAccountIds).toContain('c');
        expect(after.myGroup).toBeNull();
        expect((await service.getWorkflow('a')).metrics?.openedUserDays).toBe(
          1,
        );
        expect(
          (await service.getWorkflow('a')).metrics?.publishedUserDays,
        ).toBe(3);
        expect(
          (await service.getWorkflow('a')).conversations.find(
            (c) => c.kind === 'group',
          )!.generation,
        ).toBeGreaterThan(before.generation);
      } finally {
        await h.close();
      }
    });
    it('does not restore a candidate who stops accepting during group route planning', async () => {
      const h = await factory();
      let armed = false;
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => {
            if (armed) {
              armed = false;
              await service.executeWorkflow('c', {
                type: 'availability',
                accepting: false,
              });
            }
            return {
              provider: 'synthetic-group-race',
              distanceMeters: 8500,
              durationSeconds: 1200,
              polyline: [a, b],
            };
          },
        },
      });
      try {
        for (const id of ['a', 'b', 'c'])
          await service.publishIntent(id, publish);
        await service.executeWorkflow('a', {
          type: 'request',
          kind: 'carpool_invite',
          targetIntentId: 'intent-b',
          firstMessage: '同行',
          travelMode: 'shared_taxi',
        });
        await service.executeWorkflow('b', {
          type: 'resolve',
          requestId: (await service.getWorkflow('b')).requests[0]!.id,
          action: 'accept',
        });
        armed = true;
        expect((await service.getState('a')).groupMatches).toHaveLength(0);
      } finally {
        await h.close();
      }
    });
    it('stopping new matches invalidates pending invitations without removing a group', async () => {
      const h = await factory();
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-stop',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.publishIntent('a', publish);
        await service.publishIntent('b', publish);
        await service.executeWorkflow('a', {
          type: 'request',
          kind: 'carpool_invite',
          targetIntentId: 'intent-b',
          firstMessage: '同行邀请',
          travelMode: 'shared_taxi',
        });
        const request = (await service.getWorkflow('b')).requests[0]!;
        await service.executeWorkflow('a', {
          type: 'availability',
          accepting: false,
        });
        await expect(
          service.executeWorkflow('b', {
            type: 'resolve',
            requestId: request.id,
            action: 'accept',
          }),
        ).rejects.toThrow(/失效|处理|停止/);
        expect((await service.getWorkflow('b')).myGroup).toBeNull();
      } finally {
        await h.close();
      }
    });
    it('matches and admits today’s intents when the same account has yesterday’s stored route', async () => {
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
            provider: 'synthetic-dates',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.publishIntent('c', publish);
        clock = new Date('2026-09-09T00:00:00Z');
        for (const id of ['a', 'b', 'c'])
          await service.publishIntent(id, {
            ...publish,
            requestKey: `second-day-${id}`,
            travelDate: '2026-09-09',
            departureTime: '2026-09-09T18:30:00+08:00',
          });
        await service.executeWorkflow('a', {
          type: 'request',
          kind: 'carpool_invite',
          targetIntentId: 'intent-b-2026-09-09',
          firstMessage: '今天同行',
          travelMode: 'shared_taxi',
        });
        await service.executeWorkflow('b', {
          type: 'resolve',
          requestId: (await service.getWorkflow('b')).requests[0]!.id,
          action: 'accept',
        });
        expect((await service.getState('c')).groupMatches).toHaveLength(1);
        await service.executeWorkflow('c', {
          type: 'request',
          kind: 'group_join',
          targetIntentId: 'intent-a-2026-09-09',
          firstMessage: '加入今天的组',
        });
        await service.executeWorkflow('a', {
          type: 'resolve',
          requestId: (await service.getWorkflow('a')).requests.find(
            (request) => request.kind === 'group_join',
          )!.id,
          action: 'accept',
        });
        expect(
          (await service.getWorkflow('c')).myGroup?.members.some(
            (member) => member.intentId === 'intent-c-2026-09-09',
          ),
        ).toBe(true);
      } finally {
        await h.close();
      }
    });

    it('rechecks stopped target authorization in the same transaction that reads preview geometry', async () => {
      const h = await factory();
      let armed = false;
      const options = {
        store: h.store,
        now: () => fixed,
        createId: (id: string) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (
            a: typeof publish.origin.coordinate,
            b: typeof publish.origin.coordinate,
          ) => ({
            provider: 'synthetic-preview-race',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      };
      const base = createParkCarpoolService({ ...options, config: carpoolTestConfig });
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        ...options,
        store: {
          ...h.store,
          transactWorkflow: async (park, id, operation) => {
            const result = await h.store.transactWorkflow!(park, id, operation);
            if (armed && result === undefined) {
              armed = false;
              await base.stopIntent('b', 'intent-b');
            }
            return result;
          },
        },
      });
      try {
        await base.publishIntent('a', publish);
        await base.publishIntent('b', publish);
        armed = true;
        await expect(service.routePreview('a', 'intent-b')).rejects.toThrow(
          /更新|无权/,
        );
      } finally {
        await h.close();
      }
    });

    it('persists administrator public meeting points, denies member writes and protects edit versions', async () => {
      const h = await factory();
      const workflow = createCarpoolWorkflow({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
      });
      const command = {
        type: 'save_meeting_point' as const,
        name: '园区公共南门',
        place: publish.origin,
      };
      try {
        await expect(workflow.execute('b', command)).rejects.toThrow(/无权/);
        await workflow.execute('a', command);
        const point = (await workflow.read('b')).meetingPoints[0]!;
        expect(point.name).toBe('园区公共南门');
        await expect(
          workflow.execute('a', {
            ...command,
            id: point.id,
            expectedVersion: 0,
          }),
        ).rejects.toThrow(/更新/);
        await workflow.execute('a', {
          type: 'delete_meeting_point',
          id: point.id,
          expectedVersion: point.version,
        });
        expect((await workflow.read('b')).meetingPoints).toHaveLength(0);
      } finally {
        await h.close();
      }
    });

    it('requires a live match, deduplicates reverse requests, conceals ignore and accepts chat without grouping', async () => {
      const h = await factory();
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-workflow',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      const workflow = createCarpoolWorkflow({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
      });
      try {
        await expect(
          workflow.execute('a', {
            type: 'request',
            targetIntentId: 'intent-b',
            kind: 'text',
            firstMessage: '可以聊聊同行吗？',
          }),
        ).rejects.toThrow();
        await service.publishIntent('a', publish);
        await service.publishIntent('b', publish);
        await workflow.execute('a', {
          type: 'request',
          targetIntentId: 'intent-b',
          kind: 'text',
          firstMessage: '可以聊聊同行吗？',
        });
        const pending = (await workflow.read('b')).requests[0]!;
        await expect(
          workflow.execute('b', {
            type: 'request',
            targetIntentId: 'intent-a',
            kind: 'text',
            firstMessage: '你好',
          }),
        ).rejects.toThrow(/请求/);
        await workflow.execute('b', {
          type: 'resolve',
          requestId: pending.id,
          action: 'ignore',
        });
        expect((await workflow.read('a')).requests[0]!.status).toBe('pending');
        await expect(
          workflow.execute('a', {
            type: 'resolve',
            requestId: pending.id,
            action: 'accept',
          }),
        ).rejects.toThrow(/无权/);
        await workflow.execute('b', {
          type: 'resolve',
          requestId: pending.id,
          action: 'accept',
        });
        const accepted = await workflow.read('a');
        expect(accepted.conversations).toHaveLength(1);
        expect(accepted.conversations[0]!.kind).toBe('direct');
        expect(accepted.myGroup).toBeNull();
        await workflow.execute('b', {
          type: 'resolve',
          requestId: pending.id,
          action: 'accept',
        });
        expect((await workflow.read('a')).conversations).toHaveLength(1);
        const restarted = createCarpoolWorkflow({ config: carpoolTestConfig,
          store: h.store,
          now: () => fixed,
        });
        expect((await restarted.read('b')).conversations).toHaveLength(1);
        await h.disable();
        expect((await restarted.read('b')).conversations[0]?.status).toBe(
          'archived',
        );
      } finally {
        await h.close();
      }
    });

    it('invalidates changed intent versions and enforces block in both directions', async () => {
      const h = await factory();
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-workflow',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      const workflow = createCarpoolWorkflow({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-group-planner',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.publishIntent('a', publish);
        await service.publishIntent('b', publish);
        await workflow.execute('a', {
          type: 'request',
          targetIntentId: 'intent-b',
          kind: 'text',
          firstMessage: '你好',
        });
        const request = (await workflow.read('b')).requests[0]!;
        await service.publishIntent('a', {
          ...publish,
          requestKey: 'changed-request',
          flexibleMinutes: 10,
        });
        await expect(
          workflow.execute('b', {
            type: 'resolve',
            requestId: request.id,
            action: 'accept',
          }),
        ).rejects.toThrow(/失效/);
        await workflow.execute('b', { type: 'block', targetAccountId: 'a' });
        await expect(
          workflow.execute('a', {
            type: 'request',
            targetIntentId: 'intent-b',
            kind: 'text',
            firstMessage: '你好',
          }),
        ).rejects.toThrow(/联系|匹配/);
        await expect(
          workflow.execute('b', {
            type: 'request',
            targetIntentId: 'intent-a',
            kind: 'text',
            firstMessage: '你好',
          }),
        ).rejects.toThrow(/联系|匹配/);
        expect((await service.getState('a')).matches).toHaveLength(0);
      } finally {
        await h.close();
      }
    });

    it('accepts one explicit invitation atomically and never creates duplicate two-person groups', async () => {
      const h = await factory();
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-workflow',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      const workflow = createCarpoolWorkflow({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-group-planner',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.publishIntent('a', {
          ...publish,
          travelOptions: ['driver'],
        });
        await service.publishIntent('b', {
          ...publish,
          travelOptions: ['rider'],
        });
        await expect(
          workflow.execute('a', {
            type: 'request',
            targetIntentId: 'intent-b',
            kind: 'carpool_invite',
            firstMessage: '一起出发',
          }),
        ).rejects.toThrow(/方式/);
        await workflow.execute('a', {
          type: 'request',
          targetIntentId: 'intent-b',
          kind: 'carpool_invite',
          firstMessage: '一起出发',
          travelMode: 'private_vehicle',
          driverAccountId: 'a',
          passengerCapacity: 1,
        });
        const request = (await workflow.read('b')).requests[0]!;
        await Promise.all([
          workflow.execute('b', {
            type: 'resolve',
            requestId: request.id,
            action: 'accept',
          }),
          workflow.execute('b', {
            type: 'resolve',
            requestId: request.id,
            action: 'accept',
          }),
        ]);
        const state = await workflow.read('a');
        expect(state.myGroup?.members.map((m) => m.accountId).sort()).toEqual([
          'a',
          'b',
        ]);
        expect(state.myGroup?.driverAccountId).toBe('a');
        expect(state.myGroup?.status).toBe('full');
        await expect(service.stopIntent('a', 'intent-a')).rejects.toThrow(
          /选择/,
        );
        expect((await h.store.getIntent('a'))?.status).toBe('active');
        expect(
          state.conversations.filter((c) => c.kind === 'group'),
        ).toHaveLength(1);
        expect((await service.getState('b')).matches).toHaveLength(0);
      } finally {
        await h.close();
      }
    });

    it('requires a new driver to confirm capacity and supports invitation into an existing group', async () => {
      const h = await factory();
      const mapProvider = {
        configured: true,
        searchPlaces: async () => [],
        planDrivingRoute: async (
          a: typeof publish.origin.coordinate,
          b: typeof publish.origin.coordinate,
        ) => ({
          provider: 'synthetic-transfer',
          distanceMeters: 8500,
          durationSeconds: 1200,
          polyline: [a, b],
        }),
      };
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider,
      });
      try {
        for (const id of ['a', 'b', 'c'])
          await service.publishIntent(id, {
            ...publish,
            travelOptions: ['driver', 'rider'],
          });
        await service.executeWorkflow('a', {
          type: 'request',
          kind: 'carpool_invite',
          targetIntentId: 'intent-b',
          firstMessage: '同行',
          travelMode: 'private_vehicle',
          driverRole: 'sender',
          passengerCapacity: 3,
        });
        await service.executeWorkflow('b', {
          type: 'resolve',
          requestId: (await service.getWorkflow('b')).requests[0]!.id,
          action: 'accept',
        });
        await service.executeWorkflow('a', {
          type: 'request',
          kind: 'group_invite',
          targetIntentId: 'intent-c',
          firstMessage: '加入本组',
        });
        await service.executeWorkflow('c', {
          type: 'resolve',
          requestId: (await service.getWorkflow('c')).requests[0]!.id,
          action: 'accept',
        });
        expect((await service.getWorkflow('c')).myGroup?.members).toHaveLength(
          3,
        );
        await service.executeWorkflow('a', {
          type: 'propose_transfer',
          targetAccountId: 'b',
        });
        await expect(
          service.executeWorkflow('b', { type: 'accept_transfer' }),
        ).rejects.toThrow(/容量/);
        await expect(
          service.executeWorkflow('b', {
            type: 'accept_transfer',
            passengerCapacity: 1,
          }),
        ).rejects.toThrow(/容量/);
        await service.executeWorkflow('b', {
          type: 'accept_transfer',
          passengerCapacity: 2,
        });
        expect((await service.getWorkflow('b')).myGroup).toMatchObject({
          driverAccountId: 'b',
          coordinatorAccountId: 'b',
          passengerCapacity: 2,
          status: 'full',
        });
        await expect(
          service.executeWorkflow('a', { type: 'block', targetAccountId: 'b' }),
        ).rejects.toThrow(/确认退出/);
        await service.executeWorkflow('a', {
          type: 'block',
          targetAccountId: 'b',
          leaveSharedGroup: true,
        });
        expect((await service.getWorkflow('a')).myGroup).toBeNull();
        expect(
          (await service.getWorkflow('b')).myGroup?.members.map(
            (member) => member.accountId,
          ),
        ).toEqual(['b', 'c']);
      } finally {
        await h.close();
      }
    });

    it('serializes the last place, rotates member generations, and persists leave-and-stop', async () => {
      const h = await factory();
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-capacity',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      const workflow = createCarpoolWorkflow({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-group-planner',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.publishIntent('a', {
          ...publish,
          travelOptions: ['driver'],
        });
        for (const id of ['b', 'c', 'd'])
          await service.publishIntent(id, {
            ...publish,
            travelOptions: ['rider'],
          });
        await workflow.execute('a', {
          type: 'request',
          kind: 'carpool_invite',
          targetIntentId: 'intent-b',
          firstMessage: '一起出发',
          travelMode: 'private_vehicle',
          driverAccountId: 'a',
          passengerCapacity: 2,
        });
        await workflow.execute('b', {
          type: 'resolve',
          requestId: (await workflow.read('b')).requests[0]!.id,
          action: 'accept',
        });
        expect(
          (await service.getState('c')).groupMatches?.[0]?.memberCount,
        ).toBe(2);
        expect(
          (await service.getState('a')).groupMatches?.some(
            (match) => match.inviteToMyGroup && match.intentId === 'intent-c',
          ),
        ).toBe(true);
        for (const id of ['c', 'd'])
          await workflow.execute(id, {
            type: 'request',
            kind: 'group_join',
            targetIntentId: 'intent-a',
            firstMessage: '申请加入',
          });
        const requests = (await workflow.read('a')).requests.filter(
          (r) => r.kind === 'group_join',
        );
        const outcomes = await Promise.allSettled(
          requests.map((r) =>
            workflow.execute('a', {
              type: 'resolve',
              requestId: r.id,
              action: 'accept',
            }),
          ),
        );
        expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(
          1,
        );
        const group = (await workflow.read('a')).myGroup!;
        expect(group.members).toHaveLength(3);
        expect(group.status).toBe('full');
        const joined = group.members.find((m) =>
          ['c', 'd'].includes(m.accountId),
        )!.accountId;
        const generations = (await workflow.read(joined)).conversations[0]!
          .generations;
        expect(generations).toHaveLength(1);
        expect(generations[0]!.generation).toBe(2);
        await workflow.execute(joined, { type: 'leave', stopLooking: true });
        expect((await h.store.getIntent(joined))?.status).toBe('paused');
        expect((await workflow.read(joined)).myGroup).toBeNull();
        const remaining = (await workflow.read('a')).myGroup!;
        expect(remaining.members).toHaveLength(2);
        await workflow.execute('a', { type: 'leave', stopLooking: false });
        expect((await workflow.read('b')).myGroup).toBeNull();
      } finally {
        await h.close();
      }
    });

    it('rolls back rather than expiring requests when a stored route cannot be decrypted', async () => {
      const h = await factory();
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-fault',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      const workflow = createCarpoolWorkflow({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-group-planner',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      try {
        await service.publishIntent('a', publish);
        await service.publishIntent('b', publish);
        await workflow.execute('a', {
          type: 'request',
          kind: 'text',
          targetIntentId: 'intent-b',
          firstMessage: '你好',
        });
        const before = await h.workflowCipher();
        await h.corruptIntent();
        await expect(workflow.read('a')).rejects.toThrow();
        expect(await h.workflowCipher()).toBe(before);
      } finally {
        await h.close();
      }
    });
  });
}

it.skipIf(process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1')(
  'uses a single PostgreSQL pool connection without nested borrowing',
  async () => {
    const h = await postgresHarness(1);
    try {
      const workflow = createCarpoolWorkflow({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-group-planner',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      const states = await Promise.all(
        Array.from({ length: 4 }, () => workflow.read('a')),
      );
      expect(states).toHaveLength(4);
    } finally {
      await h.close();
    }
  },
);
