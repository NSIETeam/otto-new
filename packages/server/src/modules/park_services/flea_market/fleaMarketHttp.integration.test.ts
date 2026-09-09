/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import sharp from 'sharp';
import { createEncryptedObjectStore } from '../../data_platform/index.js';
import { createMarketApplication } from './fleaMarketApplication.js';
import { handleMarketHttp } from './fleaMarketHttp.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: HTTP uploads decoded private photos and enforces current permissions through publishing and moderation`, async () => {
    const h = await harness();
    const root = mkdtempSync(join(tmpdir(), 'otto-market-http-'));
    const base = await marketServiceFixture(h.repository);
    const app = createMarketApplication({
      ...base,
      ready: () => true,
      objects: createEncryptedObjectStore({
        root,
        keyProvider: { getKey: () => Buffer.alloc(32, 71), clear() {} },
      }),
      principal: async (tx, actor) => {
        const p = await base.principal(tx, actor);
        return (
          p && { ...p, marketAdminParkIds: actor === 'stranger' ? ['P'] : [] }
        );
      },
    });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      await handleMarketHttp({
        req,
        res,
        url,
        path: url.pathname,
        method: req.method!,
        memberAccount: req.headers['x-test-account']
          ? { id: String(req.headers['x-test-account']) }
          : null,
        application: app,
        readBody: async (request) => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          return JSON.parse(Buffer.concat(chunks).toString());
        },
        sendJSON: (response, status, value) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(value));
        },
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    const call = (
      path: string,
      actor: string,
      method = 'GET',
      body?: unknown,
    ) =>
      fetch(`http://127.0.0.1:${port}/enterprise/park-market${path}`, {
        method,
        headers: {
          'x-test-account': actor,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      expect((await call('/mine', '')).status).toBe(401);
      const empty = await call('', 'buyer');
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ items: [] });
      const bytes = await sharp({
        create: { width: 32, height: 24, channels: 3, background: 'blue' },
      })
        .png()
        .toBuffer();
      const upload = await fetch(
        `http://127.0.0.1:${port}/enterprise/park-market/images?draftId=draft`,
        {
          method: 'POST',
          headers: {
            'x-test-account': 'seller',
            'Content-Type': 'application/octet-stream',
          },
          body: new Uint8Array(bytes),
        },
      );
      expect(upload.status).toBe(200);
      const image = (await upload.json()) as { id: string };
      expect((await call(`/images/${image.id}`, 'buyer')).status).toBe(404);
      const publish = await call('/listings', 'seller', 'POST', {
        ...testListingFields,
        imageIds: [image.id],
        requestId: 'publish',
      });
      expect(publish.status).toBe(200);
      expect(
        (
          await call('/settings/P', 'stranger', 'PUT', {
            requestId: 'config',
            expectedVersion: 0,
            enabled: true,
            rules: '个人闲置实物，禁止广告',
            responsibleAccountId: 'stranger',
            contact: '园区运营',
          })
        ).status,
      ).toBe(200);
      const item = (await publish.json()) as { id: string; version: number };
      expect((await call(`/images/${image.id}`, 'buyer')).status).toBe(200);
      expect((await call(`/images/${image.id}`, 'outsider')).status).toBe(404);
      const photo = await call(`/images/${image.id}`, 'buyer');
      expect(photo.headers.get('cache-control')).toBe('private, no-store');
      expect(
        (await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).format,
      ).toBe('jpeg');
      const report = (await (
        await call(`/listings/${item.id}/report`, 'buyer', 'POST', {
          requestId: 'report',
          reason: 'misleading',
        })
      ).json()) as { id: string };
      expect(
        (
          await call(`/reports/${report.id}/decide`, 'stranger', 'POST', {
            requestId: 'remove',
            expectedVersion: 1,
            decision: 'remove',
            reason: '图片与商品不符',
          })
        ).status,
      ).toBe(200);
      expect((await call(`/images/${image.id}`, 'buyer')).status).toBe(404);
      expect((await call(`/images/${image.id}`, 'seller')).status).toBe(404);
      expect(
        (
          await call('/drafts/reuse-removed', 'seller', 'PUT', {
            imageIds: [image.id],
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call('/listings', 'seller', 'POST', {
            ...testListingFields,
            imageIds: [image.id],
            requestId: 'republish-removed-image',
          })
        ).status,
      ).toBe(400);
      expect((await call(`/images/${image.id}`, 'stranger')).status).toBe(200);
      await app.runJobs();
      expect(
        (
          (await (await call('/notifications', 'seller')).json()) as {
            unread: number;
          }
        ).unread,
      ).toBe(1);
      await h.repository.transaction((tx) =>
        tx
          .run("UPDATE test_market_accounts SET active=0 WHERE id='stranger'")
          .then(() => undefined),
      );
      expect((await call(`/images/${image.id}`, 'stranger')).status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await h.close();
      rmSync(root, { recursive: true });
    }
  }, 30000);
}
