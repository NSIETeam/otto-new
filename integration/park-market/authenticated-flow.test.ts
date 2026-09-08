/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createMarketSqliteRuntime } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketSqliteRuntime.js';
import {
  createEncryptedFieldCipher,
  createEncryptedObjectStore,
} from '../../packages/server/src/modules/data_platform/index.js';
import {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeKeyVault,
} from '../../packages/desktop/src/main/enterprise-e2ee.js';
import { MarketDraftStore } from '../../packages/desktop/src/main/park-market.js';
import { ParkMarketMessaging } from '../../packages/desktop/src/main/park-market-messaging.js';
import { testListingFields } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketTestSupport.js';

it('real enterprise login and membership authority drive cross-company publish / encrypted contact / reply / reserve / sale HTTP flow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'otto-market-authenticated-'));
  const previous = process.env.OTTO_ENTERPRISE_DIR;
  process.env.OTTO_ENTERPRISE_DIR = root;
  const db = await import('../../packages/server/src/enterprise/db.js');
  const { createEnterpriseServer } =
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
  const keys = { getKey: () => Buffer.alloc(32, 91), clear() {} };
  const runtime = createMarketSqliteRuntime({
    database: db.getDB(),
    cipher: createEncryptedFieldCipher({ keyProvider: keys }),
    objects: createEncryptedObjectStore({
      root: join(root, 'market-objects'),
      keyProvider: keys,
    }),
    enterpriseEnabled: (id) => db.getOrganizationFeatures(id).park_service,
    ready: () => true,
  });
  // Only dependency readiness is overridden in this disposable server; identity, sessions,
  // park membership, device approval, routes, encryption and storage are real implementations.
  const application = vi
    .spyOn(db, 'getFleaMarketApplication')
    .mockReturnValue(runtime);
  const { server } = createEnterpriseServer({
    host: '127.0.0.1',
    adminToken: 'fixture-admin-token',
    smsSender: null,
    repairSmsSender: null,
    repairFeishuSender: null,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
    ).toHaveLength(2);
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
    application.mockRestore();
    db.closeEnterpriseDatabase();
    if (previous === undefined) delete process.env.OTTO_ENTERPRISE_DIR;
    else process.env.OTTO_ENTERPRISE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
