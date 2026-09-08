/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import sharp from 'sharp';
import {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeKeyVault,
} from '../../packages/desktop/src/main/enterprise-e2ee.js';
import { MarketDraftStore } from '../../packages/desktop/src/main/park-market.js';
import { ParkMarketMessaging } from '../../packages/desktop/src/main/park-market-messaging.js';
import { testListingFields } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketTestSupport.js';

it('real enterprise login and membership authority drive cross-company publish / encrypted contact / reply / reserve / sale HTTP flow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'otto-market-acceptance-'));
  const previous = process.env.OTTO_ENTERPRISE_DIR;
  const previousLocal = process.env.OTTO_MARKET_LOCAL_ACCEPTANCE;
  process.env.OTTO_MARKET_LOCAL_ACCEPTANCE = '1';
  writeFileSync(
    join(root, '.otto-market-acceptance.json'),
    JSON.stringify({ purpose: 'isolated-local-acceptance', version: 1 }),
  );
  process.env.OTTO_ENTERPRISE_DIR = root;
  const db = await import('../../packages/server/src/enterprise/db.js');
  const { startEnterpriseServer } =
    await import('../../packages/server/src/enterprise/server.js');
  const authority = db.createAccount({
    username: 'market.operator',
    password: 'Market-fixture-operator-926!',
    name: '园区运营',
    isAdmin: true,
  });
  const park = db.createPark({
    adminOrganizationId: authority.organizationId,
    actorAccountId: authority.id,
    name: '验收园区',
  });
  const createMember = (name: string, joinPark: boolean) => {
    const org = db.createOrganization({
      name: `验收企业-${name}`,
      slug: `market-${name}`,
    });
    const account = db.createAccount({
      organizationId: org.id,
      username: `market.${name}`,
      password: 'Market-fixture-member-926!',
      name,
      isAdmin: true,
    });
    if (joinPark) {
      const invite = db.issueParkInvite({
        parkId: park.id,
        actorAccountId: authority.id,
      });
      db.joinOrganizationToPark({
        organizationId: org.id,
        actorAccountId: account.id,
        code: invite.code,
        address: 'A栋',
        roomNumber: '101',
      });
    }
    return account;
  };
  const seller = createMember('seller', true);
  const buyer = createMember('buyer', true);
  createMember('outsider', false);
  createMember('stranger', true);
  const runtime = db.getFleaMarketApplication();
  const server = startEnterpriseServer({
    port: 0,
    host: '127.0.0.1',
    adminToken: 'fixture-admin-token',
    smsSender: null,
    repairSmsSender: null,
    repairFeishuSender: null,
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  await runtime.initialize();
  expect(runtime.readiness().blocked).toEqual([]);
  expect(runtime.readiness()).toMatchObject({
    ready: true,
    mode: 'isolated-local-acceptance',
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = async (
    identifier: string,
    password = 'Market-fixture-member-926!',
  ) => {
    const res = await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBeTruthy();
    return body.token;
  };
  try {
    const tokens = {
      seller: await login('market.seller'),
      buyer: await login('market.buyer'),
      outsider: await login('market.outsider'),
      stranger: await login('market.stranger'),
      operator: await login('market.operator', 'Market-fixture-operator-926!'),
    };
    const call = async (
      token: string,
      path: string,
      method = 'GET',
      body?: unknown,
    ) =>
      fetch(`${base}/enterprise/park-market${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const request =
      (token: string) =>
      async (path: string, method = 'GET', body?: Record<string, unknown>) => {
        const res = await call(token, path, method, body);
        const value = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(`${res.status}: ${value.error}`);
        return value;
      };
    await runtime.roles.assign(authority.id, park.id, {
      requestId: 'role',
      accountId: authority.id,
      enabled: true,
    });
    const config = await call(tokens.operator, `/settings/${park.id}`, 'PUT', {
      requestId: 'config',
      expectedVersion: 0,
      enabled: true,
      rules: '个人闲置物品，请如实描述',
      contact: '园区运营',
      responsibleAccountId: authority.id,
    });
    expect(config.status).toBe(200);
    const bytes = await sharp({
      create: { width: 32, height: 24, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const upload = await fetch(
      `${base}/enterprise/park-market/images?draftId=auth-test`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.seller}`,
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array(bytes),
      },
    );
    expect(upload.status).toBe(200);
    const photo = (await upload.json()) as { id: string };
    const published = await call(tokens.seller, '/listings', 'POST', {
      ...testListingFields,
      imageIds: [photo.id],
      requestId: 'publish',
    });
    expect(published.status).toBe(200);
    const item = (await published.json()) as { id: string; version: number };
    expect((await call(tokens.buyer, `/listings/${item.id}`)).status).toBe(200);
    expect((await call(tokens.outsider, `/listings/${item.id}`)).status).toBe(
      404,
    );
    const clients = [];
    for (const [account, token] of [
      [seller, tokens.seller],
      [buyer, tokens.buyer],
    ] as const) {
      const crypto = new EnterpriseE2eeCrypto(
        new EnterpriseE2eeKeyVault({
          directory: join(root, account.id),
          deviceName: () => account.name,
          protect: (v) => Buffer.from(v).toString('base64'),
          unprotect: (v) => Buffer.from(v, 'base64').toString(),
        }),
      );
      const device = crypto.localDevice('auth-market', account.id);
      const registered = await fetch(`${base}/enterprise/e2ee/devices`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          identitySigningPublicKey: device.identitySigningPublicKey,
          deviceExchangePublicKey: device.deviceExchangePublicKey,
        }),
      });
      expect(registered.status).toBe(200);
      clients.push(
        new ParkMarketMessaging({
          context: () => ({
            crypto,
            accountId: account.id,
            organizationId: account.organizationId,
            serverScope: 'auth-market',
            serverUrl: base,
            requiresMls: false,
          }),
          ensureDevice: async () => undefined,
          request: request(token),
          async uploadAttachment(input) {
            const result = await fetch(
              `${base}/enterprise/park-market${input.path}`,
              {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${token}`,
                  'content-type': 'application/octet-stream',
                  'x-otto-attachment-proof': Buffer.from(
                    JSON.stringify(input.attachmentProof),
                  ).toString('base64url'),
                },
                body: Buffer.from(input.attachmentBase64, 'base64'),
              },
            );
            expect(result.status).toBe(200);
            return result.json();
          },
          pending: new MarketDraftStore(
            join(root, `pending-${account.id}`),
            (v) => Buffer.from(v),
            (v) => v.toString(),
          ),
        }),
      );
    }
    const first = (await clients[1].send({
      kind: 'listing',
      id: item.id,
      expectedVersion: 1,
      question: '可以调节高度吗？',
      requestId: 'first',
    })) as { conversationId: string; requestId: string };
    expect(
      (await clients[0].messages(first.conversationId)).items[0].content,
    ).toBe('可以调节高度吗？');
    await clients[0].send({
      kind: 'reply',
      id: first.requestId,
      conversationId: first.conversationId,
      question: '可以调节，今晚交接。',
      requestId: 'reply',
    });
    expect(
      (await clients[1].messages(first.conversationId)).items.at(-1)?.content,
    ).toBe('可以调节，今晚交接。');
    const chatData = Buffer.from('HTTP private attachment');
    await clients[1].send({
      kind: 'conversation',
      id: first.conversationId,
      question: '附件说明',
      requestId: 'http-file',
      attachments: [
        {
          fileName: '验收.txt',
          mimeType: 'text/plain',
          size: chatData.length,
          data: chatData.toString('base64'),
        },
      ],
    });
    const attachmentMessage = (
      await clients[0].messages(first.conversationId)
    ).items.find((m) => m.id === 'http-file')!;
    expect(attachmentMessage.attachments).toHaveLength(1);
    expect(
      (
        await clients[0].download(
          first.conversationId,
          attachmentMessage.id,
          attachmentMessage.sequence,
          attachmentMessage.attachments[0].id,
        )
      ).data,
    ).toBe(chatData.toString('base64'));
    const thirdParty = await call(
      tokens.stranger,
      `/chat-attachments/${attachmentMessage.attachments[0].id}/read`,
      'POST',
      {
        deviceId: 'unknown',
        signature: 'invalid',
        payload: { id: attachmentMessage.attachments[0].id },
      },
    );
    expect(thirdParty.status).toBe(403);

    expect(
      (await call(tokens.stranger, `/conversations/${first.conversationId}`))
        .status,
    ).toBe(404);
    const reserved = await call(
      tokens.seller,
      `/listings/${item.id}/reserve`,
      'POST',
      {
        requestId: 'reserve',
        expectedVersion: 1,
        expectedAt: Date.now() + 3600000,
        note: '仅本人可见',
      },
    );
    expect(reserved.status).toBe(200);
    expect(
      (
        await call(tokens.seller, `/listings/${item.id}/sold`, 'POST', {
          requestId: 'sold',
          expectedVersion: 2,
        })
      ).status,
    ).toBe(200);
    expect((await call(tokens.stranger, `/listings/${item.id}`)).status).toBe(
      200,
    );
    expect(
      (await clients[1].messages(first.conversationId)).items,
    ).toHaveLength(3);
    if (process.env.OTTO_MARKET_DESKTOP_FLOW === '1') {
      const uiBuyer = createMember('ui-buyer', true);
      const uiToken = await login('market.ui-buyer');
      const uiCrypto = new EnterpriseE2eeCrypto(
        new EnterpriseE2eeKeyVault({
          directory: join(root, 'ui-crypto'),
          deviceName: () => 'UI buyer',
          protect: (v) => Buffer.from(v).toString('base64'),
          unprotect: (v) => Buffer.from(v, 'base64').toString(),
        }),
      );
      const uiDevice = uiCrypto.localDevice('auth-market', uiBuyer.id);
      const registered = await fetch(`${base}/enterprise/e2ee/devices`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${uiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(uiDevice),
      });
      expect(registered.status).toBe(200);
      const uiMessages = new ParkMarketMessaging({
        context: () => ({
          crypto: uiCrypto,
          accountId: uiBuyer.id,
          organizationId: uiBuyer.organizationId,
          serverScope: 'auth-market',
          serverUrl: base,
          requiresMls: false,
        }),
        ensureDevice: async () => undefined,
        request: request(uiToken),
        pending: new MarketDraftStore(
          join(root, 'ui-pending'),
          (v) => Buffer.from(v),
          (v) => v.toString(),
        ),
      });
      const actors = [seller, uiBuyer];
      const auth = [tokens.seller, uiToken];
      const messengers = [clients[0], uiMessages];
      const drafts = new MarketDraftStore(
        join(root, 'ui-drafts'),
        (v) => Buffer.from(v),
        (v) => v.toString(),
      );
      const { runMarketDesktopFlow } = await import('./desktop-flow.mjs');
      const result = await runMarketDesktopFlow({
        accounts: actors.map((account) => ({
          id: account.id,
          scope: {
            server: base,
            organization: account.organizationId,
            account: account.id,
          },
        })),
        photo: bytes,
        invoke: async (index: number, kind: string, input: unknown) => {
          if (kind === 'send')
            return messengers[index].send(
              input as Parameters<ParkMarketMessaging['send']>[0],
            );
          if (kind === 'messages') {
            const value = input as { id: string; before?: number };
            return messengers[index].messages(value.id, value.before);
          }
          if (kind === 'drafts') {
            const scope = {
              server: base,
              organization: actors[index].organizationId,
              account: actors[index].id,
            };
            if (input !== undefined) drafts.save(scope, input);
            return drafts.load(scope);
          }
          const value = input as {
            path: string;
            method: string;
            body?: Record<string, unknown>;
            imageBase64?: string;
          };
          if (value.imageBase64) {
            const response = await fetch(
              `${base}/enterprise/park-market${value.path}`,
              {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${auth[index]}`,
                  'content-type': 'application/octet-stream',
                },
                body: new Uint8Array(Buffer.from(value.imageBase64, 'base64')),
              },
            );
            const body = await response.json();
            if (!response.ok) throw new Error(JSON.stringify(body));
            return body;
          }
          return request(auth[index])(value.path, value.method, value.body);
        },
      });
      const mine = await runtime.market.mine(seller.id);
      expect(
        mine.find((record) => record.title === '双桌面验收台灯')?.state,
      ).toBe('sold');
      writeFileSync(
        join(
          process.cwd(),
          'docs/research/flea-market-evidence/authenticated-electron.json',
        ),
        JSON.stringify(result, null, 2),
      );
    }
    db.getDB()
      .prepare("UPDATE accounts SET status='disabled' WHERE id=?")
      .run(buyer.id);
    expect(
      (await call(tokens.buyer, `/conversations/${first.conversationId}`))
        .status,
    ).toBe(401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    if (previousLocal === undefined)
      delete process.env.OTTO_MARKET_LOCAL_ACCEPTANCE;
    else process.env.OTTO_MARKET_LOCAL_ACCEPTANCE = previousLocal;
    db.closeEnterpriseDatabase();
    if (previous === undefined) delete process.env.OTTO_ENTERPRISE_DIR;
    else process.env.OTTO_ENTERPRISE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
