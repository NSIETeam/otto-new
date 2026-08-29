/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JsonChannelCredentialVaultV1,
  type ChannelCredentialProtectorV1,
} from './channelCredentialVault.js';

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-channel-vault-'));
  roots.push(root);
  const protector: ChannelCredentialProtectorV1 = {
    protect: vi.fn((value: string) => `protected:${Buffer.from(value).toString('base64url')}`),
    unprotect: vi.fn((value: string) => Buffer.from(value.slice('protected:'.length), 'base64url').toString()),
  };
  const vault = new JsonChannelCredentialVaultV1(
    path.join(root, 'channels.json'),
    protector,
    () => 123,
  );
  const installation = {
    installationId: 'channel_feishu_0123456789abcdef01234567',
    provider: 'feishu' as const,
    tenantId: 'tenant-1',
    tenantName: 'Acme',
    botName: 'Otto',
    grantedScopes: ['im:message'],
    connectedAtMs: 100,
  };
  return { root, protector, vault, installation };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('JsonChannelCredentialVaultV1', () => {
  it('persists only protected data and makes repeated commits idempotent', async () => {
    const { root, protector, vault, installation } = fixture();
    await vault.commit(installation, 'refresh-token-secret');
    await vault.commit(installation, 'a-replayed-value-is-ignored');

    expect(protector.protect).toHaveBeenCalledTimes(1);
    const raw = fs.readFileSync(path.join(root, 'channels.json'), 'utf8');
    expect(raw).not.toContain('refresh-token-secret');
    expect(raw).not.toContain('a-replayed-value-is-ignored');
    expect(fs.statSync(path.join(root, 'channels.json')).mode & 0o777).toBe(0o600);
    await expect(vault.loadCredential({
      installationId: installation.installationId,
      provider: 'feishu',
      tenantId: 'tenant-1',
    })).resolves.toBe('refresh-token-secret');
    expect(vault.listInstallations()).toEqual([installation]);
  });

  it('rejects idempotency conflicts and cross-tenant reads or removal', async () => {
    const { vault, installation } = fixture();
    await vault.commit(installation, 'secret');
    await expect(vault.commit({ ...installation, tenantId: 'tenant-2' }, 'other'))
      .rejects.toThrow('idempotency conflict');
    const wrongTenant = {
      installationId: installation.installationId,
      provider: 'feishu' as const,
      tenantId: 'tenant-2',
    };
    await expect(vault.loadCredential(wrongTenant)).rejects.toThrow('tenant mismatch');
    await expect(vault.remove(wrongTenant)).rejects.toThrow('tenant mismatch');
    await expect(vault.remove({ ...wrongTenant, tenantId: 'tenant-1' })).resolves.toBe(true);
  });

  it('fails closed when a protector returns plaintext', async () => {
    const { root, installation } = fixture();
    const vault = new JsonChannelCredentialVaultV1(
      path.join(root, 'unsafe.json'),
      { protect: (value) => value, unprotect: (value) => value },
    );
    await expect(vault.commit(installation, 'secret')).rejects.toThrow('unsafe output');
    expect(fs.existsSync(path.join(root, 'unsafe.json'))).toBe(false);
  });
});
