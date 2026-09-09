import { carpoolTestConfig } from './parkCarpoolTestSupport.js';
import { generateKeyPairSync, sign } from 'node:crypto';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FileMlsStatePersistence, ParkMlsNativeKernel } from '@otto/native';
import { createParkCarpoolService } from './parkCarpoolService.js';
import { createParkCarpoolTransport } from './parkCarpoolTransport.js';
import {
  carpoolTestNativeBinary,
  sqliteHarness,
  postgresHarness,
  fixed,
  publish,
} from './parkCarpoolTestSupport.js';

for (const [name, factory] of [
  ['SQLite', sqliteHarness],
  ['PostgreSQL', postgresHarness],
] as const) {
  it.skipIf(
    name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1',
  )(
    `${name}: public transport proves possession of the approved device key`,
    async () => {
      const h = await factory();
      const keys = generateKeyPairSync('ed25519');
      await h.approveDevices(
        keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      );
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        mapProvider: {
          configured: false,
          searchPlaces: async () => [],
          planDrivingRoute: async () => {
            throw new Error('unused');
          },
        },
      });
      const command = {
        type: 'publish_key' as const,
        deviceId: 'device-a',
        deviceScope: `${'a'.repeat(64)}/org-a/a/device-a`,
        reference: 'c'.repeat(64),
        keyPackage: Buffer.from('signed package').toString('base64'),
      };
      const timestamp = fixed.toISOString();
      const proof = {
        timestamp,
        signature: sign(
          null,
          Buffer.from(
            JSON.stringify([
              'otto:park-carpool-device:v1',
              'a',
              timestamp,
              command,
            ]),
          ),
          keys.privateKey,
        ).toString('base64'),
      };
      try {
        await expect(
          service.executeSignedTransport('a', command, undefined),
        ).rejects.toThrow(/无权/);
        expect(
          await service.executeSignedTransport('a', command, proof),
        ).toMatchObject({ usable: true });
        await expect(
          service.executeSignedTransport(
            'a',
            { ...command, reference: 'd'.repeat(64) },
            proof,
          ),
        ).rejects.toThrow(/无权/);
        await expect(
          service.executeSignedTransport('a', command, {
            ...proof,
            timestamp: new Date(fixed.getTime() - 120_000).toISOString(),
          }),
        ).rejects.toThrow(/无权/);
      } finally {
        await h.close();
      }
    },
    30_000,
  );
  it.skipIf(
    name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1',
  )(
    `${name}: expired unclaimed packages can be securely retired`,
    async () => {
      const h = await factory();
      await h.approveDevices();
      let now = fixed;
      const transport = createParkCarpoolTransport({ config: carpoolTestConfig,
        store: h.store,
        now: () => now,
      });
      try {
        const command = {
          type: 'publish_key' as const,
          deviceId: 'device-a',
          deviceScope: `${'a'.repeat(64)}/org-a/a/device-a`,
          reference: 'a'.repeat(64),
          keyPackage: Buffer.from('test package').toString('base64'),
        };
        await transport.execute('a', command);
        now = new Date(fixed.getTime() + 86_400_001);
        expect(await transport.execute('a', command)).toMatchObject({
          usable: false,
          retirable: true,
        });
        expect(
          await transport.execute('a', {
            ...command,
            reference: 'e'.repeat(64),
            expired: true,
          }),
        ).toMatchObject({ published: false, usable: false, retirable: true });
      } finally {
        await h.close();
      }
    },
    30_000,
  );
  it.skipIf(
    name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1',
  )(
    `${name}: actual native processes exchange ciphertext through authorized persistent transport`,
    async () => {
      const h = await factory();
      await h.approveDevices();
      const directory = await mkdtemp(
        path.join(tmpdir(), 'otto-park-native-contract-'),
      );
      const nativePath = carpoolTestNativeBinary();
      const kernels = ['a', 'b'].map(
        (accountId) =>
          new ParkMlsNativeKernel(
            {
              serverUrl: 'http://127.0.0.1:54321',
              organizationId: accountId === 'a' ? 'org-a' : 'org-b',
              accountId,
              deviceId: `device-${accountId}`,
            },
            new FileMlsStatePersistence({
              filePath: path.join(directory, `${accountId}.json`),
              protectStateKey: (key) => `test-only:${key}`,
              unprotectStateKey: (key) => key.slice('test-only:'.length),
            }),
            nativePath,
          ),
      );
      const [alice, bob] = kernels as [
        ParkMlsNativeKernel,
        ParkMlsNativeKernel,
      ];
      const service = createParkCarpoolService({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
        createId: (id) => `intent-${id}`,
        mapProvider: {
          configured: true,
          searchPlaces: async () => [],
          planDrivingRoute: async (a, b) => ({
            provider: 'synthetic-transport',
            distanceMeters: 8500,
            durationSeconds: 1200,
            polyline: [a, b],
          }),
        },
      });
      const transport = createParkCarpoolTransport({ config: carpoolTestConfig,
        store: h.store,
        now: () => fixed,
      });
      try {
        for (const [id, kernel] of [
          ['a', alice],
          ['b', bob],
        ] as const) {
          await service.publishIntent(id, publish);
          const key = await kernel.createKeyPackage();
          await transport.execute(id, {
            type: 'publish_key',
            deviceId: `device-${id}`,
            deviceScope: kernel.deviceScope,
            reference: key.reference,
            keyPackage: key.key_package,
          });
        }
        await expect(
          transport.execute('a', {
            type: 'state',
            deviceId: 'device-a',
            conversationId: 'forged',
          }),
        ).rejects.toThrow(/无权/);
        await service.executeWorkflow('a', {
          type: 'request',
          kind: 'text',
          targetIntentId: 'intent-b',
          firstMessage: '聊聊同行',
        });
        await service.executeWorkflow('b', {
          type: 'resolve',
          requestId: (await service.getWorkflow('b')).requests[0]!.id,
          action: 'accept',
        });
        const conversationId = (await service.getWorkflow('a'))
          .conversations[0]!.id;
        const setup = await transport.execute('a', {
          type: 'state',
          deviceId: 'device-a',
          conversationId,
        });
        if (!('sessions' in setup)) throw new Error('missing transport state');
        const session = setup.sessions[0]!;
        expect(session.initialization).toBeTruthy();
        const invitation = await alice.create(
          session.authority,
          session.initialization!.packages,
        );
        await transport.execute('a', {
          type: 'activate',
          deviceId: 'device-a',
          conversationId,
          generation: session.authority.generation,
          leaseId: session.initialization!.leaseId,
          groupId: invitation.group_id,
          welcome: invitation.welcome,
        });
        const joined = await transport.execute('b', {
          type: 'state',
          deviceId: 'device-b',
          conversationId,
        });
        if (!('sessions' in joined)) throw new Error('missing joined state');
        const recipient = joined.sessions[0]!;
        await bob.join(
          recipient.authority,
          recipient.reference!,
          recipient.groupId!,
          recipient.welcome!,
        );
        const encrypted = await alice.encrypt(
          session.authority,
          'message-native-contract',
          '只有获接受的同行伙伴能读到',
        );
        await transport.execute('a', {
          type: 'append',
          deviceId: 'device-a',
          conversationId,
          generation: session.authority.generation,
          eventId: 'message-native-contract',
          groupId: encrypted.group_id,
          epoch: encrypted.epoch,
          ciphertext: encrypted.ciphertext,
        });
        const inbox = await transport.execute('b', {
          type: 'state',
          deviceId: 'device-b',
          conversationId,
        });
        if (!('events' in inbox)) throw new Error('missing inbox');
        expect(JSON.stringify(inbox)).not.toContain('只有获接受');
        const event = inbox.events[0]!;
        expect(
          await bob.decrypt(
            recipient.authority,
            event.id,
            event.sender,
            event.ciphertext,
          ),
        ).toBe('只有获接受的同行伙伴能读到');
        await transport.execute('b', {
          type: 'read',
          deviceId: 'device-b',
          conversationId,
          sequence: event.sequence,
        });
        await expect(
          transport.execute('a', {
            type: 'append',
            deviceId: 'device-b',
            conversationId,
            generation: 1,
            eventId: 'forged-device',
            groupId: encrypted.group_id,
            epoch: encrypted.epoch,
            ciphertext: encrypted.ciphertext,
          }),
        ).rejects.toThrow(/无权/);
        await service.executeWorkflow('b', {
          type: 'block',
          targetAccountId: 'a',
        });
        await expect(
          transport.execute('a', {
            type: 'append',
            deviceId: 'device-a',
            conversationId,
            generation: 1,
            eventId: 'after-block',
            groupId: encrypted.group_id,
            epoch: encrypted.epoch,
            ciphertext: encrypted.ciphertext,
          }),
        ).rejects.toThrow(/屏蔽/);
      } finally {
        await Promise.all(kernels.map((k) => k.close()));
        await h.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
