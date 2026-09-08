/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * server 端点发现读写单测。
 *
 * endpoint.ts 在每次读写时解析 OTTO_USER_DIR，未设置时回退到用户目录。
 * 测试用环境变量隔离目录，并覆盖模块加载后的配置切换。
 * 全程临时 HOME，不碰真实 ~/.otto-user。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

let tmpHome: string;

/** 动态加载独立 endpoint 模块实例。 */
async function loadEndpoint(): Promise<typeof import('./endpoint.js')> {
  vi.resetModules();
  return import('./endpoint.js');
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-endpoint-'));
  // 隔离默认 HOME 和显式配置，确保所有读写仅触及本次临时目录。
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('OTTO_USER_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('endpoint write/read round-trip', () => {
  it('switches discovery and cleanup to OTTO_USER_DIR without touching the prior profile', async () => {
    const ep = await loadEndpoint();
    ep.writeEndpoint('127.0.0.1', 7637, 'prior-client-token');
    const priorPath = ep.endpointFilePath();
    const isolated = path.join(tmpHome, 'isolated');
    vi.stubEnv('OTTO_USER_DIR', isolated);
    expect(ep.endpointFilePath()).toBe(path.join(isolated, 'server-endpoint.json'));
    expect(ep.readEndpoint()).toBeUndefined();
    ep.writeEndpoint('127.0.0.1', 7638, 'isolated-client-token');
    expect(ep.readEndpoint()?.port).toBe(7638);
    ep.clearEndpoint();
    expect(ep.readEndpoint()).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(priorPath, 'utf8')).clientToken).toBe('prior-client-token');
  });

  it('write 后 read 一致', async () => {
    const ep = await loadEndpoint();
    const controlToken = 'a'.repeat(43);
    const clientToken = 'b'.repeat(43);
    const written = ep.writeEndpoint(
      '127.0.0.1',
      7637,
      clientToken,
      controlToken,
    );
    expect(written.host).toBe('127.0.0.1');
    expect(written.port).toBe(7637);
    expect(written.pid).toBe(process.pid);

    const read = ep.readEndpoint();
    expect(read).toBeDefined();
    expect(read!.host).toBe('127.0.0.1');
    expect(read!.port).toBe(7637);
    expect(read!.protocolVersion).toBe(written.protocolVersion);
    expect(read?.clientToken).toBe(clientToken);
    expect(read).not.toHaveProperty('controlToken');
    expect(ep.readEndpointRecord()?.controlToken).toBe(controlToken);
    expect(ep.readEndpointRecord()?.clientToken).toBe(clientToken);
    expect(
      JSON.parse(fs.readFileSync(ep.endpointFilePath(), 'utf8')).controlToken,
    ).toBe(controlToken);
    if (process.platform !== 'win32') {
      expect(fs.statSync(ep.endpointFilePath()).mode & 0o777).toBe(0o600);
    }
  });

  it('endpointFilePath 指向临时 HOME', async () => {
    const ep = await loadEndpoint();
    expect(ep.endpointFilePath()).toBe(
      path.join(tmpHome, '.otto-user', 'server-endpoint.json'),
    );
  });

  it('read 不存在文件 → undefined（不抛）', async () => {
    const ep = await loadEndpoint();
    expect(ep.readEndpoint()).toBeUndefined();
  });

  it('旧端点文件缺 clientToken 时 fail closed，不生成或回填假 token', async () => {
    const ep = await loadEndpoint();
    fs.mkdirSync(path.dirname(ep.endpointFilePath()), { recursive: true });
    fs.writeFileSync(
      ep.endpointFilePath(),
      JSON.stringify({
        host: '127.0.0.1',
        port: 7637,
        protocolVersion: '1',
        pid: process.pid,
        startedAt: Date.now(),
        controlToken: 'legacy-control-token',
      }),
    );

    expect(ep.readEndpoint()).toBeUndefined();
    expect(ep.readEndpointRecord()).toBeUndefined();
    expect(fs.readFileSync(ep.endpointFilePath(), 'utf8')).not.toContain(
      'clientToken',
    );
  });

  it('clear 后 read → undefined', async () => {
    const ep = await loadEndpoint();
    ep.writeEndpoint('127.0.0.1', 7637, 'client-token');
    expect(ep.readEndpoint()).toBeDefined();
    ep.clearEndpoint();
    expect(ep.readEndpoint()).toBeUndefined();
  });

  it('clear 不存在文件不抛', async () => {
    const ep = await loadEndpoint();
    expect(() => ep.clearEndpoint()).not.toThrow();
  });
});
