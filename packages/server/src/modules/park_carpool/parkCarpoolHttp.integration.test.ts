/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { sqliteHarness, fixed, publish } from './parkCarpoolTestSupport.js';
import { createParkCarpoolService } from './parkCarpoolService.js';
import { handleParkCarpoolHttp } from './parkCarpoolHttp.js';

it('executes HTTP publish → matches → confirm → stop against encrypted SQLite', async () => {
  const h = await sqliteHarness();
  const keys = generateKeyPairSync('ed25519');
  await h.approveDevices(
    keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  const service = createParkCarpoolService({
    store: h.store,
    now: () => fixed,
    createId: (id) => `intent-${id}`,
    mapProvider: {
      configured: true,
      searchPlaces: async () => [],
      planDrivingRoute: async (origin, destination) => ({
        provider: 'synthetic-http-fixture',
        distanceMeters: 8500,
        durationSeconds: 1200,
        polyline: [origin, destination],
      }),
    },
  });
  // Authentication is supplied at the adapter seam; no production credentials or users.
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    void handleParkCarpoolHttp({
      service,
      path: url.pathname,
      url,
      method: req.method!,
      req,
      res,
      memberAccount: req.headers['x-test-actor'] === 'a' ? { id: 'a' } : null,
      readBody: async (request) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        return JSON.parse(body);
      },
      sendJSON: (response, status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      },
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/enterprise/park-carpool`;
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { 'x-test-actor': 'a', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    expect((await fetch(base)).status).toBe(401);
    const created = await call('/intents', 'PUT', {
      ...publish,
      accountId: 'b',
      parkId: 'forged',
    });
    expect(created.status).toBe(200);
    const receipt = (await created.json()) as {
      intent: { id: string; accountId: string; parkId: string };
    };
    expect(receipt.intent).toMatchObject({ accountId: 'a', parkId: 'park-a' });
    await service.publishIntent('b', publish);
    const results = (await (await call('/matches')).json()) as {
      state: { matches: unknown[] };
    };
    expect(results.state.matches).toHaveLength(1);
    expect(JSON.stringify(results.state.matches)).not.toContain('二〇一');
    const sent = await call('/workflow', 'POST', {
      type: 'request',
      targetIntentId: 'intent-b',
      kind: 'text',
      firstMessage: '一起出发吗？',
    });
    expect(sent.status).toBe(200);
    const transportDenied = await call('/transport', 'POST', {
      type: 'state',
      deviceId: 'forged',
      conversationId: 'forged',
    });
    expect(transportDenied.status).toBe(403);
    const command = {
      type: 'publish_key',
      deviceId: 'device-a',
      deviceScope: `${'a'.repeat(64)}/org-a/a/device-a`,
      reference: 'c'.repeat(64),
      keyPackage: Buffer.from('test-http-package').toString('base64'),
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
    expect(
      (await call('/transport', 'POST', { ...command, proof })).status,
    ).toBe(200);
    expect(
      (
        await call('/transport', 'POST', {
          ...command,
          reference: 'd'.repeat(64),
          proof,
        })
      ).status,
    ).toBe(403);
    const workflow = (await (await call('/workflow')).json()) as {
      workflow: { requests: Array<{ firstMessage: string }> };
    };
    expect(workflow.workflow.requests[0]?.firstMessage).toBe('一起出发吗？');
    expect(
      (await call('/intents/confirm', 'POST', { intentId: receipt.intent.id }))
        .status,
    ).toBe(200);
    expect(
      (await call('/intents/stop', 'POST', { intentId: receipt.intent.id }))
        .status,
    ).toBe(200);
    expect(
      (await call('/intents/stop', 'POST', { intentId: receipt.intent.id }))
        .status,
    ).toBe(200);
    expect(
      (await call('/intents/stop', 'POST', { intentId: 'intent-b' })).status,
    ).toBe(403);
    expect((await h.store.getIntent('a'))?.status).toBe('paused');
    expect((await service.getWorkflow('a')).hasActiveIntent).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h.close();
  }
});
