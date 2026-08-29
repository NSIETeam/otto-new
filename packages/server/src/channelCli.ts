/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Thin CLI over the local authenticated channel supervisor API. It never reads
 * provider credentials and never starts a second gateway.
 */

import type { ServerEndpointRecord } from './endpoint.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import type {
  ChannelHealth,
  ChannelInstallation,
  ChannelProvider,
  PairingSession,
} from './modules/integration_adapters/channelConnector.js';
import { channelInstallationProofPayload } from './modules/integration_adapters/channelConnector.js';
import type { ChannelIdentityBindingV1 } from './modules/integration_adapters/channelIdentityRegistry.js';

export interface ChannelCliDependencies {
  readEndpointRecord(): ServerEndpointRecord | undefined;
  fetchImpl?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type ChannelCliAction = 'login' | 'list' | 'status' | 'start' | 'stop' | 'send' | 'logout'
  | 'identities' | 'bind-user' | 'revoke-user';

function parseArguments(args: readonly string[]): {
  action: ChannelCliAction;
  installationId?: string;
  target?: string;
  text?: string;
  idempotencyKey?: string;
  providerUserId?: string;
  canonicalUserId?: string;
  approvalId?: string;
  approvedBy?: string;
  expectedRevision?: number;
} {
  const action = (args[0] ?? 'status') as ChannelCliAction;
  if (!['login', 'list', 'status', 'start', 'stop', 'send', 'logout',
    'identities', 'bind-user', 'revoke-user'].includes(action)) {
    throw new Error('用法: otto <feishu|lark|wecom> <login|list|status|start|stop|send|logout|identities|bind-user|revoke-user> ...');
  }
  const installationId = args[1];
  if (installationId && !/^channel_(feishu|lark|wecom)_[a-f0-9]{24}$/.test(installationId)) {
    throw new Error('installation id 不合法');
  }
  if (action === 'send') {
    const target = args[2]?.trim();
    const text = args[3]?.trim();
    const idempotencyKey = args[4]?.trim();
    if (!installationId || !target || !text || !idempotencyKey) {
      throw new Error('用法: otto <provider> send <installation-id> <target> <text> <idempotency-key>');
    }
    return { action, installationId, target, text, idempotencyKey };
  }
  if (action === 'bind-user' || action === 'revoke-user') {
    const providerUserId = args[2]?.trim();
    const offset = action === 'bind-user' ? 1 : 0;
    const canonicalUserId = action === 'bind-user' ? args[3]?.trim() : undefined;
    const approvalId = args[3 + offset]?.trim();
    const approvedBy = args[4 + offset]?.trim();
    const rawRevision = args[5 + offset]?.trim();
    const expectedRevision = rawRevision === undefined ? Number.NaN : Number(rawRevision);
    if (!installationId || !providerUserId || (action === 'bind-user' && !canonicalUserId)
      || !approvalId || !approvedBy || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0) {
      throw new Error(
        action === 'bind-user'
          ? '用法: otto <provider> bind-user <installation-id> <provider-user-id> <otto-user-id> <approval-id> <approved-by> <expected-revision>'
          : '用法: otto <provider> revoke-user <installation-id> <provider-user-id> <approval-id> <approved-by> <expected-revision>',
      );
    }
    return {
      action, installationId, providerUserId,
      ...(canonicalUserId ? { canonicalUserId } : {}),
      approvalId, approvedBy, expectedRevision,
    };
  }
  return { action, ...(installationId ? { installationId } : {}) };
}

export async function runChannelCli(
  provider: ChannelProvider,
  args: readonly string[],
  dependencies: ChannelCliDependencies,
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  try {
    const input = parseArguments(args);
    const endpoint = dependencies.readEndpointRecord();
    if (!endpoint?.controlToken) throw new Error('Otto 本地服务未运行或控制令牌不可用');
    if (endpoint.host !== '127.0.0.1' && endpoint.host !== 'localhost' && endpoint.host !== '::1') {
      throw new Error('拒绝通过非回环端点执行渠道控制');
    }
    const request = async (
      requestPath: string,
      method = 'GET',
      body?: unknown,
    ): Promise<unknown> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      timer.unref?.();
      try {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const response = await (dependencies.fetchImpl ?? fetch)(
          `http://${endpoint.host}:${endpoint.port}${requestPath}`,
          {
            method,
            redirect: 'error',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${endpoint.controlToken}`,
              ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: payload,
          },
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 64 * 1024) throw new Error('本地服务响应过大');
        let envelope: { ok?: boolean; data?: unknown; error?: unknown };
        try {
          envelope = JSON.parse(bytes.toString('utf8')) as typeof envelope;
        } catch {
          throw new Error('本地服务返回了无效 JSON');
        }
        if (!response.ok || envelope.ok !== true) {
          throw new Error(
            typeof envelope.error === 'string' ? envelope.error : `本地服务请求失败 (${response.status})`,
          );
        }
        return envelope.data;
      } finally {
        clearTimeout(timer);
      }
    };
    if (input.action === 'login') {
      const keys = generateKeyPairSync('ed25519');
      const installationPublicKey = keys.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString();
      const scopes: Record<ChannelProvider, string[]> = {
        feishu: ['im:message', 'contact:user.base:readonly'],
        lark: ['im:message', 'contact:user.base:readonly'],
        wecom: ['message.send', 'contacts.read.basic'],
      };
      let pairing = (await request('/channels/pairings', 'POST', {
        provider,
        installationPublicKey,
        requestedScopes: scopes[provider],
      })) as PairingSession;
      stdout(`${provider}: 请扫码授权 ${pairing.qrPayload}`);
      let announcedAdminWait = false;
      const now = dependencies.now ?? Date.now;
      const sleep = dependencies.sleep ?? ((milliseconds: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
      while (now() < pairing.expiresAtMs) {
        if (pairing.status === 'user_authorized') {
          const installed = (await request(
            `/channels/pairings/${pairing.pairingId}/install`,
            'POST',
            {
              installationPublicKey,
              signature: sign(
                null,
                channelInstallationProofPayload(pairing.pairingId),
                keys.privateKey,
              ).toString('base64url'),
            },
          )) as ChannelInstallation;
          stdout(`${provider}: 已安装 ${installed.tenantName} / ${installed.botName}`);
          return 0;
        }
        if (['expired', 'denied', 'failed', 'revoked'].includes(pairing.status)) {
          throw new Error(`${provider}: 配对终止 (${pairing.status})`);
        }
        if (pairing.status === 'waiting_admin' && !announcedAdminWait) {
          stdout(`${provider}: 等待企业管理员在供应商平台批准`);
          announcedAdminWait = true;
        }
        await sleep(2_000);
        pairing = (await request(
          `/channels/pairings/${pairing.pairingId}`,
        )) as PairingSession;
      }
      throw new Error(`${provider}: 二维码已过期`);
    }
    const installations = (await request('/channels/installations')) as ChannelInstallation[];
    const matching = installations.filter((installation) => installation.provider === provider);
    if (input.action === 'list') {
      if (matching.length === 0) stdout(`${provider}: 未安装`);
      else matching.forEach((installation) => stdout(
        `${installation.installationId}\t${installation.tenantName}\t${installation.botName}`,
      ));
      return 0;
    }
    const installation = input.installationId
      ? matching.find((candidate) => candidate.installationId === input.installationId)
      : matching.length === 1
        ? matching[0]
        : undefined;
    if (!installation) {
      if (matching.length > 1 && !input.installationId) {
        throw new Error('存在多个安装，请在命令末尾指定 installation id');
      }
      throw new Error(`${provider}: 未找到对应安装`);
    }
    if (input.action === 'logout') {
      await request(`/channels/installations/${installation.installationId}`, 'DELETE');
      stdout(`${provider}: 已注销 ${installation.tenantName}`);
      return 0;
    }
    if (input.action === 'identities') {
      const identities = (await request(
        `/channels/installations/${installation.installationId}/identities`,
      )) as ChannelIdentityBindingV1[];
      if (identities.length === 0) stdout(`${provider}: 暂无身份绑定`);
      else identities.forEach((identity) => stdout(
        `${identity.providerUserId}\t${identity.canonicalUserId}\t` +
        `${identity.active ? 'active' : 'revoked'}\trevision=${identity.revision}`,
      ));
      return 0;
    }
    if (input.action === 'bind-user' || input.action === 'revoke-user') {
      const identity = (await request(
        `/channels/installations/${installation.installationId}/identities`,
        'POST',
        {
          action: input.action === 'bind-user' ? 'bind' : 'revoke',
          providerUserId: input.providerUserId,
          ...(input.canonicalUserId ? { canonicalUserId: input.canonicalUserId } : {}),
          approvalId: input.approvalId,
          approvedBy: input.approvedBy,
          expectedRevision: input.expectedRevision,
        },
      )) as ChannelIdentityBindingV1;
      stdout(
        `${provider}: ${identity.active ? '已绑定' : '已撤销'} ` +
        `${identity.providerUserId} -> ${identity.canonicalUserId} revision=${identity.revision}`,
      );
      return 0;
    }
    if (input.action === 'send') {
      const receipt = (await request(
        `/channels/installations/${installation.installationId}/send`,
        'POST',
        {
          target: input.target,
          text: input.text,
          idempotencyKey: input.idempotencyKey,
        },
      )) as { idempotencyKey: string; providerMessageId: string };
      stdout(
        `${provider}: committed providerMessageId=${receipt.providerMessageId} ` +
        `idempotencyKey=${receipt.idempotencyKey}`,
      );
      return 0;
    }
    const action = input.action === 'status' ? 'health' : input.action;
    const health = (await request(
      `/channels/installations/${installation.installationId}/${action}`,
      input.action === 'status' ? 'GET' : 'POST',
    )) as ChannelHealth;
    stdout(
      `${provider}: ${health.state} (${health.running ? 'running' : 'stopped'}) ` +
      `reconnects=${health.reconnectCount}`,
    );
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
