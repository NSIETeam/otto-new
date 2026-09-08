import { carpoolTestConfig } from './park-carpool-test-support.js';
import { carpoolTestNativeBinary } from './park-carpool-test-support.js';
import { createHash } from 'node:crypto';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  Database,
  createEncryptedFieldCipher,
  createParkCarpoolService,
  createParkCarpoolSqliteStore,
  PARK_CARPOOL_SCHEMA_CONTRIBUTOR,
} from 'otto-server';
import { ParkCarpoolChat } from './park-carpool-chat.js';

it('desktop coordinators exchange, retry after lost response, and restore actual MLS ciphertext from SQLite', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'otto-park-chat-ui-'));
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE accounts(id TEXT PRIMARY KEY); CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('a'),('b'); INSERT INTO organizations VALUES ('org-a'),('org-b'); CREATE TABLE e2ee_devices(account_id TEXT,organization_id TEXT,device_id TEXT,approval_state TEXT,revoked_at TEXT); INSERT INTO e2ee_devices VALUES ('a','org-a','device-a','approved',NULL),('b','org-b','device-b','approved',NULL);",
  );
  PARK_CARPOOL_SCHEMA_CONTRIBUTOR.apply(db);
  const store = createParkCarpoolSqliteStore({
    db: () => db,
    fieldCipher: createEncryptedFieldCipher({
      keyProvider: {
        getKey: () => Buffer.alloc(32, 17),
        clear: () => undefined,
      },
    }),
    getPrincipal: (id) =>
      ['a', 'b'].includes(id)
        ? {
            accountId: id,
            organizationId: `org-${id}`,
            organizationName: '测试企业',
            displayName: id,
            parkId: 'park-test',
            active: true,
            parkServiceEnabled: true,
          }
        : null,
  });
  let clock = new Date('2026-09-08T00:00:00Z');
  const now = () => clock;
  const createService = (enabled: boolean) => createParkCarpoolService({ config: Object.freeze({...carpoolTestConfig, requestsEnabled: enabled}),
    store,
    now,
    createId: (id) => `intent-${id}`,
    mapProvider: {
      configured: true,
      searchPlaces: async () => [],
      planDrivingRoute: async (a, b) => ({
        provider: 'synthetic',
        distanceMeters: 8500,
        durationSeconds: 1200,
        polyline: [a, b],
      }),
    },
  });
  let service = createService(true);
  let loseResponse = false;
  let pauseOnAppend = false;
  const create = (id: string) =>
    new ParkCarpoolChat({
      stateDirectory: directory,
      binaryPath: carpoolTestNativeBinary(),
      secureStorage: {
        assertAvailable: () => undefined,
        protect: (s) => `test:${s}`,
        unprotect: (s) => s.slice(5),
      },
      client: {
        getParkCarpoolWorkflow: () => service.getWorkflow(id),
        executeParkCarpoolTransport: async (command) => {
          if (pauseOnAppend && command.type === 'append')
            service = createService(false);
          const result = await service.executeTransport(id, command);
          if (loseResponse && command.type === 'append') {
            loseResponse = false;
            throw new Error('response lost');
          }
          return result;
        },
      },
    });
  const alice = create('a');
  let bob = create('b');
  const scope = (id: string) => ({
    serverUrl: 'http://127.0.0.1:54321',
    organizationId: `org-${id}`,
    accountId: id,
    deviceId: `device-${id}`,
    approvalState: 'approved' as const,
  });
  try {
    for (const id of ['a', 'b'])
      await service.publishIntent(id, {
        requestKey: `publish-${id}`,
        travelDate: '2026-09-08',
        departureTime: '2026-09-08T18:30:00+08:00',
        flexibleMinutes: 30,
        travelOptions: ['shared_taxi'],
        origin: {
          label: '园区南门',
          coordinate: { longitude: 116, latitude: 40 },
        },
        destination: {
          label: '地铁站',
          coordinate: { longitude: 116.1, latitude: 40 },
        },
      });
    await alice.activate(scope('a'));
    await bob.activate(scope('b'));
    await service.executeWorkflow('a', {
      type: 'request',
      kind: 'text',
      targetIntentId: 'intent-b',
      firstMessage: '聊聊',
    });
    await service.executeWorkflow('b', {
      type: 'resolve',
      requestId: (await service.getWorkflow('b')).requests[0]!.id,
      action: 'accept',
    });
    const id = (await service.getWorkflow('a')).conversations[0]!.id;
    service = createService(false);
    expect((await alice.read(id)).canSend).toBe(false);
    service = createService(true);
    await alice.read(id);
    await bob.read(id);
    loseResponse = true;
    await expect(
      alice.send(id, '真实桌面加密消息', 'stable-message-id'),
    ).rejects.toThrow(/response lost/);
    const recovered = await alice.read(id);
    expect(recovered.messages).toHaveLength(1);
    expect((await bob.read(id)).messages[0]?.text).toBe('真实桌面加密消息');
    pauseOnAppend = true;
    await expect(
      alice.send(id, '暂停中的待发送消息', 'pause-pending'),
    ).rejects.toThrow(/暂停/);
    const paused = await alice.read(id);
    expect(paused.canSend).toBe(false);
    expect(
      paused.messages.find((m) => m.id === 'stable-message-id')?.text,
    ).toBe('真实桌面加密消息');
    expect(paused.messages.find((m) => m.id === 'pause-pending')?.pending).toBe(
      true,
    );
    service = createService(true);
    const rejectedRetry = await alice.read(id);
    expect(rejectedRetry.pendingSendError).toMatch(/暂停/);
    expect(
      rejectedRetry.messages.find((m) => m.id === 'stable-message-id')?.text,
    ).toBe('真实桌面加密消息');
    pauseOnAppend = false;
    service = createService(true);
    expect(
      (await alice.read(id)).messages.find((m) => m.id === 'pause-pending')
        ?.pending,
    ).toBe(false);
    expect(
      (await bob.read(id)).messages.filter((m) => m.id === 'pause-pending'),
    ).toHaveLength(1);
    const transport = await service.executeTransport('a', {
      type: 'state',
      deviceId: 'device-a',
      conversationId: id,
    });
    if (!transport.sessions) throw new Error('missing session');
    const session = transport.sessions[0]!;
    await service.executeTransport('a', {
      type: 'append',
      deviceId: 'device-a',
      conversationId: id,
      generation: 1,
      eventId: 'bad-cipher-event',
      groupId: session.groupId!,
      epoch: 1,
      ciphertext: 'AAAA',
    });
    await alice.send(id, '坏消息之后仍能发送', 'after-bad-cipher');
    expect(
      (await bob.read(id)).messages.some(
        (message) => message.text === '坏消息之后仍能发送',
      ),
    ).toBe(true);
    expect((await bob.read(id)).failedMessageCount).toBe(1);
    await bob.close();
    bob = create('b');
    await bob.activate(scope('b'));
    expect((await bob.read(id)).messages[0]?.text).toBe('真实桌面加密消息');
    await bob.close();
    const lostManifest = createHash('sha256')
      .update(JSON.stringify(scope('b')))
      .digest('hex');
    await rm(path.join(directory, `${lostManifest}.json`));
    clock = new Date(clock.getTime() + 120_000);
    await bob.activate(scope('b'));
    await bob.recover(id, 1);
    await alice.read(id);
    await bob.read(id);
    await alice.send(id, '恢复后新消息', 'after-recovery');
    const restored = await bob.read(id);
    expect(restored.messages.map((m) => m.text)).toEqual(['恢复后新消息']);
    expect(restored.unavailableHistoryCount).toBe(4);
    await service.executeWorkflow('b', { type: 'block', targetAccountId: 'a' });
    await expect(alice.send(id, '不能发送', 'blocked-message')).rejects.toThrow(
      /屏蔽/,
    );
  } finally {
    await alice.close();
    await bob.close();
    vi.unstubAllEnvs();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
