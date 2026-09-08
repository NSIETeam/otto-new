/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEncryptedObjectStore } from '../data_platform/index.js';
import { createParkContactAttachments } from './parkContactAttachments.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
} from '../park_services/flea_market/fleaMarketTestSupport.js';
for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: private attachment stages once, binds atomically, survives restart and never uses listing grants`, async () => {
    const h = await harness();
    const root = mkdtempSync(join(tmpdir(), 'otto-chat-attachments-'));
    try {
      const deps = await marketServiceFixture(h.repository);
      const objects = createEncryptedObjectStore({
        root,
        keyProvider: { getKey: () => Buffer.alloc(32, 27), clear() {} },
      });
      await h.repository.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO park_market_conversations VALUES ('chat','P','buyer','seller','active',0)",
        );
        await tx.run(
          'CREATE TABLE test_attachment_devices(account_id TEXT,device_id TEXT,approved INTEGER)',
        );
        await tx.run(
          "INSERT INTO test_attachment_devices VALUES ('buyer','b',1),('seller','s',1)",
        );
      });
      const options = {
        ...deps,
        objects,
        deviceAllowed: async (
          tx: Parameters<typeof deps.principal>[0],
          actor: string,
          device: string,
        ) =>
          (
            await tx.all(
              'SELECT device_id FROM test_attachment_devices WHERE account_id=? AND device_id=? AND approved=1',
              [actor, device],
            )
          ).length > 0,
      };
      let attachments = createParkContactAttachments(options);
      const input = {
        conversationId: 'chat',
        messageId: 'message',
        id: 'attachment',
        deviceId: 'b',
        bytes: Buffer.alloc(40, 5),
      };
      expect(await attachments.upload('buyer', input)).toMatchObject({
        id: 'attachment',
        bytes: 40,
      });
      expect(await attachments.upload('buyer', input)).toMatchObject({
        id: 'attachment',
      });
      await expect(
        attachments.upload('buyer', { ...input, bytes: Buffer.alloc(40, 6) }),
      ).rejects.toThrow('CONFLICT');
      await expect(
        attachments.read('seller', 'attachment', 's'),
      ).rejects.toThrow('NOT_FOUND');
      await expect(
        h.repository.transaction(async (tx) => {
          await attachments.bind(tx, 'buyer', 'chat', 'message', [
            'attachment',
          ]);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      await expect(
        attachments.read('seller', 'attachment', 's'),
      ).rejects.toThrow('NOT_FOUND');
      await h.repository.transaction((tx) =>
        attachments.bind(tx, 'buyer', 'chat', 'message', ['attachment']),
      );
      expect(await attachments.read('seller', 'attachment', 's')).toEqual(
        input.bytes,
      );
      await expect(
        attachments.read('stranger', 'attachment', 's'),
      ).rejects.toThrow('NOT_FOUND');
      await expect(
        attachments.read('outsider', 'attachment', 's'),
      ).rejects.toThrow('NOT_FOUND');
      await h.restart();
      attachments = createParkContactAttachments({
        ...options,
        repository: h.repository,
      });
      expect(await attachments.read('buyer', 'attachment', 'b')).toEqual(
        input.bytes,
      );
      await h.repository.transaction((tx) =>
        tx.run(
          "UPDATE test_attachment_devices SET approved=0 WHERE account_id='buyer'",
        ),
      );
      await expect(
        attachments.read('buyer', 'attachment', 'b'),
      ).rejects.toThrow('FORBIDDEN');
      expect(await attachments.read('seller', 'attachment', 's')).toEqual(
        input.bytes,
      );
      await attachments.cleanup();
      expect(await attachments.read('seller', 'attachment', 's')).toEqual(
        input.bytes,
      );
      let time = deps.now();
      const interrupted = createParkContactAttachments({
        ...options,
        repository: h.repository,
        now: () => time,
        objects: {
          ...objects,
          put(value) {
            objects.put(value);
            throw new Error('interrupted after object write');
          },
        },
      });
      await expect(
        interrupted.upload('seller', {
          ...input,
          id: 'interrupted',
          deviceId: 's',
        }),
      ).rejects.toThrow('interrupted');
      expect(objects.listKeys()).toHaveLength(2);
      await h.restart();
      time += 86400001;
      await createParkContactAttachments({
        ...options,
        repository: h.repository,
        now: () => time,
      }).cleanup();
      expect(objects.listKeys()).toHaveLength(1);
    } finally {
      await h.close();
      rmSync(root, { recursive: true });
    }
  }, 30000);
}
