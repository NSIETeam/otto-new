import { ParkMarketMls } from '../../packages/desktop/src/main/park-market-mls.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeKeyVault,
} from '../../packages/desktop/src/main/enterprise-e2ee.js';
import { MarketDraftStore } from '../../packages/desktop/src/main/park-market.js';
import { ParkMarketMessaging } from '../../packages/desktop/src/main/park-market-messaging.js';
import { createMarketApplication } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketApplication.js';
import { createEncryptedObjectStore } from '../../packages/server/src/modules/data_platform/index.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
  testListingFields,
} from '../../packages/server/src/modules/park_services/flea_market/fleaMarketTestSupport.js';

for (const nativeMls of [false, true])
  for (const [backend, harness] of [
    ['sqlite', sqliteMarketHarness],
    ['postgres', postgresMarketHarness],
  ] as const) {
    it(`${backend}/${nativeMls ? 'native MLS' : 'envelope'}: real device encryption survives lost response, offline seller, reply and database restart without plaintext on server`, async () => {
      const h = await harness(),
        root = mkdtempSync(join(tmpdir(), 'otto-market-encrypted-'));
      const nativeClients: ParkMarketMls[] = [];
      try {
        const base = await marketServiceFixture(h.repository);
        const endpoint = (account: string) => {
          const vault = new EnterpriseE2eeKeyVault({
            directory: join(root, account),
            deviceName: () => account,
            now: () => new Date(base.now()),
            protect: (text) => Buffer.from(text).toString('base64'),
            unprotect: (text) => Buffer.from(text, 'base64').toString(),
          });
          const crypto = new EnterpriseE2eeCrypto(vault);
          return { crypto, device: crypto.localDevice('market-test', account) };
        };
        const buyer = endpoint('buyer'),
          seller = endpoint('seller');
        await h.repository.transaction(async (tx) => {
          if (backend === 'sqlite') {
            await tx.run(
              'CREATE TABLE e2ee_devices(organization_id TEXT,account_id TEXT,device_id TEXT,device_name TEXT,identity_signing_public_key TEXT,device_exchange_public_key TEXT,key_fingerprint TEXT,approval_state TEXT,approved_by_device_id TEXT,approved_at TEXT,created_at TEXT,last_seen_at TEXT,revoked_at TEXT)',
            );
            await tx.run(
              'CREATE TABLE e2ee_key_transparency_log(organization_id TEXT,sequence INTEGER,account_id TEXT,device_id TEXT,event TEXT,key_fingerprint TEXT,actor_device_id TEXT,previous_hash TEXT,entry_hash TEXT,created_at TEXT)',
            );
          } else
            for (const [account, org] of [
              ['seller', 'E1'],
              ['buyer', 'E2'],
            ]) {
              await tx.run(
                'INSERT INTO organizations(id,name,slug) VALUES (?,?,?)',
                [org, org, org],
              );
              await tx.run(
                'INSERT INTO accounts(id,organization_id,username,password_hash,name) VALUES (?,?,?,?,?)',
                [account, org, account, 'fixture-not-login', account],
              );
            }
          for (const [account, org, device] of [
            ['seller', 'E1', seller.device],
            ['buyer', 'E2', buyer.device],
          ] as const) {
            const at = new Date(base.now()).toISOString();
            await tx.run(
              'INSERT INTO e2ee_devices(organization_id,account_id,device_id,device_name,identity_signing_public_key,device_exchange_public_key,key_fingerprint,approval_state,approved_by_device_id,approved_at,created_at,last_seen_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,NULL)',
              [
                org,
                account,
                device.deviceId,
                device.deviceName,
                device.identitySigningPublicKey,
                device.deviceExchangePublicKey,
                device.keyFingerprint,
                'approved',
                at,
                at,
                at,
              ],
            );
            const entry = {
              sequence: 1,
              organizationId: org,
              accountId: account,
              deviceId: device.deviceId,
              event: 'bootstrap_approved',
              keyFingerprint: device.keyFingerprint,
              actorDeviceId: device.deviceId,
              previousHash: '0'.repeat(64),
              createdAt: at,
            };
            const hash = createHash('sha256')
              .update('otto:e2ee-key-transparency:v1\n')
              .update(JSON.stringify(entry))
              .digest('hex');
            await tx.run(
              'INSERT INTO e2ee_key_transparency_log VALUES (?,?,?,?,?,?,?,?,?,?)',
              [
                org,
                1,
                account,
                device.deviceId,
                entry.event,
                device.keyFingerprint,
                device.deviceId,
                entry.previousHash,
                hash,
                at,
              ],
            );
          }
        });
        const objects = createEncryptedObjectStore({
          root: join(root, 'objects'),
          keyProvider: { getKey: () => Buffer.alloc(32, 99), clear() {} },
        });
        const makeApp = () =>
          createMarketApplication({
            ...base,
            repository: h.repository,
            objects,
            ready: () => true,
            principal: async (tx, actor) => {
              const p = await base.principal(tx, actor);
              return (
                p && {
                  ...p,
                  marketAdminParkIds: actor === 'stranger' ? ['P'] : [],
                }
              );
            },
          });
        let app = makeApp();
        await app.settings.update('stranger', 'P', {
          requestId: 'config',
          expectedVersion: 0,
          enabled: true,
          rules: '个人闲置测试规则',
          responsibleAccountId: 'stranger',
          contact: '测试责任人',
        });
        const item = await app.market.publish('seller', {
          ...testListingFields,
          requestId: 'publish',
        });
        let loseResponse = true;
        const client = (actor: 'buyer' | 'seller', forceEnvelope = false) => {
          const context = () => ({
            crypto: actor === 'buyer' ? buyer.crypto : seller.crypto,
            accountId: actor,
            organizationId: actor === 'buyer' ? 'E2' : 'E1',
            serverScope: 'market-test',
            serverUrl: 'https://market.test',
            requiresMls: nativeMls && !forceEnvelope,
          });
          const request = async (
            path: string,
            method = 'GET',
            body: Record<string, unknown> = {},
          ) => {
            const parts = path.split('/').filter(Boolean);
            if (parts[0] === 'mls') return app.mls(actor, body as never);
            if (parts[0] === 'contact-prepare')
              return app.contacts.prepare(
                actor,
                parts[1] as 'listing' | 'conversation',
                parts[2],
              );
            if (parts[0] === 'listings') {
              const result = await app.contacts.contact(actor, parts[1], body);
              if (loseResponse) {
                loseResponse = false;
                throw new Error('simulated response loss after committed send');
              }
              return result;
            }
            if (parts[0] === 'contacts')
              return app.contacts.resolve(actor, parts[1], body);
            if (parts[0] === 'conversations')
              return method === 'GET'
                ? app.contacts.messages(actor, parts[1])
                : app.contacts.send(actor, parts[1], body);
            throw new Error('unexpected route');
          };
          const mls = nativeMls
            ? new ParkMarketMls({
                directory: join(root, `native-${actor}`),
                binaryPath: join(
                  process.cwd(),
                  'otto-native/target/debug/otto-native',
                ),
                context,
                request: (body) => request('/mls', 'POST', body),
                protect: (value) => Buffer.from(value).toString('base64'),
                unprotect: (value) => Buffer.from(value, 'base64').toString(),
              })
            : undefined;
          if (mls) nativeClients.push(mls);
          return new ParkMarketMessaging({
            context,
            ensureDevice: async () => undefined,
            request,
            mls,
            pending: new MarketDraftStore(
              join(root, `pending-${actor}`),
              (text) => Buffer.from(text),
              (bytes) => bytes.toString(),
            ),
          });
        };
        const clients = { buyer: client('buyer'), seller: client('seller') };
        for (const native of nativeClients) await native.activate();
        const input = {
          kind: 'listing' as const,
          id: item.id,
          expectedVersion: 1,
          question: '这把椅子的高度可以调吗？',
          requestId: 'first-question',
        };
        await expect(clients.buyer.send(input)).rejects.toThrow(
          'response loss',
        );
        await h.restart();
        app = makeApp();
        for (const native of nativeClients) await native.close();
        const receipt = (await clients.buyer.send(input)) as {
          conversationId: string;
          requestId: string;
        };
        expect((await app.contacts.inbox('seller')).requests).toHaveLength(1);
        const received = await clients.seller.messages(receipt.conversationId);
        expect(received.items[0].content).toBe(input.question);
        expect(received.items[0].snapshot).toMatchObject({
          title: '办公椅',
          priceCents: 1001,
        });
        await clients.seller.send({
          kind: 'reply',
          id: receipt.requestId,
          conversationId: receipt.conversationId,
          question: '可以调节，下午交接方便。',
          requestId: 'seller-reply',
        });
        expect(
          (await clients.buyer.messages(receipt.conversationId)).items[1]
            .content,
        ).toBe('可以调节，下午交接方便。');
        if (nativeMls)
          await expect(
            client('buyer', true).send({
              kind: 'conversation',
              id: receipt.conversationId,
              question: '禁止降级的信封消息',
              requestId: 'downgrade-attempt',
            }),
          ).rejects.toThrow();
        await app.market.command('seller', item.id, 'reserve', {
          requestId: 'reserve',
          expectedVersion: 1,
          note: '只给本人看的约定',
          expectedAt: base.now() + 3600000,
        });
        await app.market.command('seller', item.id, 'sold', {
          requestId: 'sold',
          expectedVersion: 2,
        });
        await clients.buyer.send({
          kind: 'conversation',
          id: receipt.conversationId,
          question: '已收到，谢谢',
          requestId: 'thanks',
        });
        expect(
          (await clients.seller.messages(receipt.conversationId)).items.map(
            (item) => item.content,
          ),
        ).toEqual([input.question, '可以调节，下午交接方便。', '已收到，谢谢']);
        if (nativeMls) {
          for (const native of nativeClients) await native.close();
          // Simulate loss of this device's MLS persistence, keeping its approved identity vault.
          rmSync(join(root, 'native-buyer'), { recursive: true, force: true });
          const unavailable = await clients.buyer.messages(
            receipt.conversationId,
          );
          expect(unavailable.items.every((item) => !!item.error)).toBe(true);
          await clients.buyer.recover(receipt.conversationId);
          await clients.buyer.send({
            kind: 'conversation',
            id: receipt.conversationId,
            question: '新连接已恢复',
            requestId: 'recovered-message',
          });
          expect(
            (await clients.seller.messages(receipt.conversationId)).items.at(-1)
              ?.content,
          ).toBe('新连接已恢复');
          const after = await clients.buyer.messages(receipt.conversationId);
          expect(after.items.at(-1)?.content).toBe('新连接已恢复');
          expect(after.items[0].error).toBeTruthy();
        }
        const stored = await h.repository.read((tx) =>
          tx.all('SELECT payload FROM park_contact_messages'),
        );
        expect(JSON.stringify(stored)).not.toContain(input.question);
        expect(
          JSON.stringify(
            await app.contacts.messages('buyer', receipt.conversationId),
          ),
        ).not.toContain('只给本人看的约定');
        const foreignCrypto = seller.crypto.encryptMessage({
          serverScope: 'market-test',
          organizationId: 'E1',
          senderAccountId: 'seller',
          recipientAccountId: 'buyer',
          messageId: 'wrong-scope',
          content: 'wrong scope',
          contentType: 'message',
          devices: [seller.device, buyer.device],
        });
        await expect(
          app.contacts.send('seller', receipt.conversationId, {
            requestId: 'wrong-scope',
            envelope: foreignCrypto,
          }),
        ).rejects.toThrow(nativeMls ? 'FORBIDDEN' : 'signature');
      } finally {
        for (const native of nativeClients) await native.close();
        await h.close();
        rmSync(root, { recursive: true });
      }
    }, 30000);
  }
