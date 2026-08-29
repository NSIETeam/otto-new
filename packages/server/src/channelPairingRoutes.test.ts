/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryRecurringTaskStateStore } from 'otto-core';
import { OttoServer } from './server.js';
import { ProductWorkspaceStore } from './productWorkspaceStore.js';
import type {
  ChannelConnectorV1,
  PairingSession,
} from './modules/integration_adapters/channelConnector.js';
import type { ManagedChannelPlatformV1 } from './modules/integration_adapters/managedChannelPlatform.js';
import type { ResidentWorkflowSupervisor } from 'otto-workflow';

const pairing: PairingSession = {
  pairingId: 'pair_0123456789abcdef01234567',
  provider: 'feishu',
  status: 'waiting_scan',
  qrPayload: 'https://pairing.example/channel/pair?opaque=1',
  expiresAtMs: Date.now() + 300_000,
  requestedScopes: ['im:message'],
};

function fakeConnector(): ChannelConnectorV1 {
  const installation = {
    installationId: 'channel_feishu_0123456789abcdef01234567',
    provider: 'feishu' as const,
    tenantId: 'tenant-1',
    tenantName: 'Example tenant',
    botName: 'Otto',
    grantedScopes: ['im:message'],
    connectedAtMs: Date.now(),
  };
  return {
    listInstallations: vi.fn(() => [installation]),
    beginPairing: vi.fn(async () => pairing),
    getPairingStatus: vi.fn(async () => pairing),
    denyPairing: vi.fn(async () => ({ ...pairing, status: 'denied' })),
    completeInstallation: vi.fn(async () => installation),
    start: vi.fn(async () => ({ installationId: 'install-1', running: true, state: 'connected', reconnectCount: 0 })),
    stop: vi.fn(async () => ({ installationId: 'install-1', running: false, state: 'stopped', reconnectCount: 0 })),
    revoke: vi.fn(async () => undefined),
    health: vi.fn(async () => ({ installationId: 'install-1', running: true, state: 'connected', reconnectCount: 0 })),
    send: vi.fn(async (_installationId, input) => ({
      idempotencyKey: input.idempotencyKey,
      providerMessageId: 'provider-message-1',
      committedAtMs: Date.now(),
    })),
  };
}

describe('channel pairing REST routes', () => {
  let userDir: string;
  let server: OttoServer | undefined;

  beforeEach(() => {
    userDir = mkdtempSync(path.join(tmpdir(), 'otto-channel-pairing-'));
    vi.stubEnv('HOME', userDir);
    vi.stubEnv('USERPROFILE', userDir);
    vi.stubEnv('OTTO_USER_DIR', userDir);
  });

  afterEach(async () => {
    await server?.stop();
    vi.unstubAllEnvs();
    rmSync(userDir, { recursive: true, force: true });
  });

  async function start(
    connectors = {},
    workspaceStore = new ProductWorkspaceStore(path.join(userDir, 'workspace.json')),
    managedChannelPlatform?: ManagedChannelPlatformV1,
    residentWorkflowSupervisor?: ResidentWorkflowSupervisor,
  ): Promise<{ baseUrl: string; token: string }> {
    server = new OttoServer({
      port: 0,
      mock: true,
      channelConnectors: connectors,
      managedChannelPlatform,
      residentWorkflowSupervisor,
      recurringTaskStateStore: new InMemoryRecurringTaskStateStore(),
      productWorkspaceStore: workspaceStore,
    });
    await server.start();
    const http = (server as unknown as { http: { address(): { port: number } } }).http;
    return {
      baseUrl: `http://127.0.0.1:${http.address().port}`,
      token: server.controlToken,
    };
  }

  it('requires the local control token and reports a missing real connector', async () => {
    const { baseUrl, token } = await start();
    const body = JSON.stringify({
      provider: 'feishu',
      installationPublicKey: 'public-key',
      requestedScopes: ['im:message'],
    });

    expect((await fetch(`${baseUrl}/channels/pairings`, { method: 'POST', body })).status).toBe(401);
    const unavailable = await fetch(`${baseUrl}/channels/pairings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      ok: false,
      error: 'channel_connector_unavailable:feishu',
    });
  });

  it('delegates begin, status, install and cancellation without local admin bypass', async () => {
    const connector = fakeConnector();
    const { baseUrl, token } = await start({ feishu: connector });
    const auth = { authorization: `Bearer ${token}` };
    const begun = await fetch(`${baseUrl}/channels/pairings`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'feishu',
        installationPublicKey: 'public-key',
        requestedScopes: ['im:message'],
      }),
    });
    expect(begun.status).toBe(201);
    expect(await begun.json()).toMatchObject({ ok: true, data: { status: 'waiting_scan' } });

    for (const [suffix, method] of [
      ['', 'GET'],
      ['', 'DELETE'],
    ] as const) {
      const response = await fetch(`${baseUrl}/channels/pairings/${pairing.pairingId}${suffix}`, {
        method,
        headers: auth,
      });
      expect(response.status).toBe(200);
    }
    const installed = await fetch(
      `${baseUrl}/channels/pairings/${pairing.pairingId}/install`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          installationPublicKey: 'public-key',
          signature: 'A'.repeat(86),
        }),
      },
    );
    expect(installed.status).toBe(200);
    expect(connector.getPairingStatus).toHaveBeenCalledOnce();
    const localApproval = await fetch(
      `${baseUrl}/channels/pairings/${pairing.pairingId}/approve`,
      { method: 'POST', headers: auth },
    );
    expect(localApproval.status).toBe(405);
    expect(connector.completeInstallation).toHaveBeenCalledOnce();
    expect(connector.completeInstallation).toHaveBeenCalledWith(
      pairing.pairingId,
      { installationPublicKey: 'public-key', signature: 'A'.repeat(86) },
    );
    expect(connector.denyPairing).toHaveBeenCalledOnce();
  });

  it('uses one authenticated installation control surface for Desktop and CLI', async () => {
    const connector = fakeConnector();
    const { baseUrl, token } = await start({ feishu: connector });
    const auth = { authorization: `Bearer ${token}` };
    const installationId = connector.listInstallations()[0].installationId;

    expect((await fetch(`${baseUrl}/channels/installations`)).status).toBe(401);
    const listed = await fetch(`${baseUrl}/channels/installations`, { headers: auth });
    expect(await listed.json()).toMatchObject({
      ok: true,
      data: [{ installationId, provider: 'feishu', tenantId: 'tenant-1' }],
    });
    for (const [suffix, method] of [
      ['', 'GET'],
      ['/health', 'GET'],
      ['/start', 'POST'],
      ['/stop', 'POST'],
      ['', 'DELETE'],
    ] as const) {
      const response = await fetch(
        `${baseUrl}/channels/installations/${installationId}${suffix}`,
        { method, headers: auth },
      );
      expect(response.status).toBe(200);
    }
    expect(connector.health).toHaveBeenCalledWith(installationId);
    expect(connector.start).toHaveBeenCalledWith(installationId);
    expect(connector.stop).toHaveBeenCalledWith(installationId);
    expect(connector.revoke).toHaveBeenCalledWith(installationId);
  });

  it('requires an explicit idempotency key for external channel writes', async () => {
    const connector = fakeConnector();
    const { baseUrl, token } = await start({ feishu: connector });
    const installationId = connector.listInstallations()[0].installationId;
    const url = `${baseUrl}/channels/installations/${installationId}/send`;
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const invalid = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ target: 'chat-1', text: 'hello' }),
    });
    expect(invalid.status).toBe(409);
    expect(connector.send).not.toHaveBeenCalled();

    const input = {
      target: 'chat-1',
      text: 'hello',
      idempotencyKey: 'msg:0123456789abcdef',
    };
    const sent = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({
      ok: true,
      data: { idempotencyKey: input.idempotencyKey, providerMessageId: 'provider-message-1' },
    });
    expect(connector.send).toHaveBeenCalledWith(installationId, input);
  });

  it('binds and revokes channel identities through the authenticated installation surface', async () => {
    const connector = fakeConnector();
    const { baseUrl, token } = await start({ feishu: connector });
    const installationId = connector.listInstallations()[0].installationId;
    const url = `${baseUrl}/channels/installations/${installationId}/identities`;
    const body = JSON.stringify({
      action: 'bind',
      providerUserId: 'ou_provider_user_1',
      canonicalUserId: 'otto-user-1',
      approvalId: 'approval-1',
      approvedBy: 'spoofed-client-admin',
      expectedRevision: 0,
      // This untrusted field must never override the installation tenant.
      tenantId: 'tenant-attacker',
    });
    expect((await fetch(url, { method: 'POST', body })).status).toBe(401);
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const bound = await fetch(url, { method: 'POST', headers, body });
    expect(bound.status).toBe(200);
    const boundPayload = await bound.json() as { data: { approvedBy: string } };
    expect(boundPayload).toMatchObject({
      ok: true,
      data: { tenantId: 'tenant-1', canonicalUserId: 'otto-user-1', revision: 1, active: true },
    });
    expect(boundPayload.data.approvedBy).not.toBe('spoofed-client-admin');
    const listed = await fetch(url, { headers });
    expect(await listed.json()).toMatchObject({
      ok: true,
      data: [{ tenantId: 'tenant-1', providerUserId: 'ou_provider_user_1', active: true }],
    });

    const stale = await fetch(url, { method: 'POST', headers, body });
    expect(stale.status).toBe(409);
    const revoked = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'revoke', providerUserId: 'ou_provider_user_1',
        approvalId: 'approval-2', expectedRevision: 1,
      }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ data: { active: false, revision: 2 } });
  });

  it('rejects enterprise members without organization management capability', async () => {
    const workspace = new ProductWorkspaceStore(path.join(userDir, 'member-workspace.json'));
    const owner = workspace.configureManager({ managerName: 'Owner', companyName: 'Acme' });
    const department = owner.managerWorkspace!.organization.departments[0];
    const position = owner.managerWorkspace!.organization.positions.find(
      (candidate) => candidate.departmentId === department.id,
    )!;
    const invite = workspace.issueInvite({
      kind: 'position', departmentId: department.id, positionId: position.id,
    });
    workspace.acceptInvite(invite.link, { userId: 'member-1', displayName: 'Member' });
    const connector = fakeConnector();
    const { baseUrl, token } = await start({ feishu: connector }, workspace);
    const installationId = connector.listInstallations()[0].installationId;
    const response = await fetch(
      `${baseUrl}/channels/installations/${installationId}/identities`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'bind', providerUserId: 'ou_user_1', canonicalUserId: 'member-1',
          approvalId: 'approval-1', expectedRevision: 0,
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'channel_identity_admin_required' });
  });

  it('uses a composed managed platform and stops it with the server lifecycle', async () => {
    const connector = fakeConnector();
    const stopAll = vi.fn(async () => undefined);
    const platform = {
      connectors: { feishu: connector },
      stopAll,
    } as unknown as ManagedChannelPlatformV1;
    const recoverInterrupted = vi.fn(async () => []);
    const supervisor = {
      recoverInterrupted,
      inputVersion: async () => undefined,
      tick: async () => [],
    } as unknown as ResidentWorkflowSupervisor;
    const { baseUrl, token } = await start(
      {},
      new ProductWorkspaceStore(path.join(userDir, 'platform-workspace.json')),
      platform,
      supervisor,
    );
    const response = await fetch(`${baseUrl}/channels/installations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await response.json()).toMatchObject({
      data: [{ provider: 'feishu', tenantId: 'tenant-1' }],
    });
    await server!.stop();
    server = undefined;
    expect(stopAll).toHaveBeenCalledOnce();
    expect(recoverInterrupted).toHaveBeenCalledOnce();
  });
});
