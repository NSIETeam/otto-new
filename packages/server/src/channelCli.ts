/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Thin CLI over the local authenticated channel supervisor API. It never reads
 * provider credentials and never starts a second gateway.
 */

import type { ServerEndpointRecord } from './endpoint.js';
import type {
  ChannelHealth,
  ChannelInstallation,
  ChannelProvider,
} from './modules/integration_adapters/channelConnector.js';

export interface ChannelCliDependencies {
  readEndpointRecord(): ServerEndpointRecord | undefined;
  fetchImpl?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

type ChannelCliAction = 'list' | 'status' | 'start' | 'stop' | 'logout';

function parseArguments(args: readonly string[]): {
  action: ChannelCliAction;
  installationId?: string;
} {
  const action = (args[0] ?? 'status') as ChannelCliAction;
  if (!['list', 'status', 'start', 'stop', 'logout'].includes(action)) {
    throw new Error('用法: otto <feishu|lark|wecom> <list|status|start|stop|logout> [installation-id]');
  }
  const installationId = args[1];
  if (installationId && !/^channel_(feishu|lark|wecom)_[a-f0-9]{24}$/.test(installationId)) {
    throw new Error('installation id 不合法');
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
    const request = async (requestPath: string, method = 'GET'): Promise<unknown> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      timer.unref?.();
      try {
        const response = await (dependencies.fetchImpl ?? fetch)(
          `http://${endpoint.host}:${endpoint.port}${requestPath}`,
          {
            method,
            redirect: 'error',
            signal: controller.signal,
            headers: { authorization: `Bearer ${endpoint.controlToken}` },
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
