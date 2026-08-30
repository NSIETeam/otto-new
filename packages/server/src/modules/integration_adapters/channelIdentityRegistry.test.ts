/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonChannelIdentityRegistryV1 } from './channelIdentityRegistry.js';

const temporaryRoots: string[] = [];
function temporaryFile(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'otto-channel-identities-'),
  );
  temporaryRoots.push(root);
  return path.join(root, 'bindings.json');
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const binding = {
  provider: 'lark' as const,
  installationId: 'installation-1',
  tenantId: 'tenant-1',
  providerUserId: 'provider-user-1',
  canonicalUserId: 'otto-user-1',
  approvalId: 'approval-1',
  approvedBy: 'admin-1',
  expectedRevision: 0,
};

describe('JsonChannelIdentityRegistryV1', () => {
  it('persists an approved binding with owner-only permissions', async () => {
    const filePath = temporaryFile();
    const audit = vi.fn();
    const registry = new JsonChannelIdentityRegistryV1({
      filePath,
      audit,
      now: () => 2_000,
    });
    await expect(registry.bind(binding)).resolves.toMatchObject({
      active: true,
      revision: 1,
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    const restored = new JsonChannelIdentityRegistryV1({
      filePath,
      audit: vi.fn(),
    });
    await expect(restored.resolve(binding)).resolves.toEqual({
      canonicalUserId: 'otto-user-1',
      active: true,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bound', approvalId: 'approval-1' }),
    );
  });

  it('isolates tenants and rejects stale administrative updates', async () => {
    const registry = new JsonChannelIdentityRegistryV1({
      filePath: temporaryFile(),
      audit: vi.fn(),
    });
    await registry.bind(binding);
    await expect(
      registry.resolve({ ...binding, tenantId: 'tenant-2' }),
    ).resolves.toBeNull();
    await expect(
      registry.bind({ ...binding, canonicalUserId: 'otto-user-2' }),
    ).rejects.toThrow('revision conflict');
    await expect(
      registry.revoke({ ...binding, expectedRevision: 0 }),
    ).rejects.toThrow('revision conflict');
  });

  it('revokes immediately and preserves the audited tombstone after restart', async () => {
    const filePath = temporaryFile();
    const audit = vi.fn();
    const registry = new JsonChannelIdentityRegistryV1({
      filePath,
      audit,
      now: () => 3_000,
    });
    await registry.bind(binding);
    await expect(
      registry.revoke({
        ...binding,
        expectedRevision: 1,
        approvalId: 'approval-2',
      }),
    ).resolves.toMatchObject({ active: false, revision: 2 });
    await expect(registry.resolve(binding)).resolves.toEqual({
      canonicalUserId: 'otto-user-1',
      active: false,
    });
    expect(
      new JsonChannelIdentityRegistryV1({ filePath, audit: vi.fn() }).list(),
    ).toEqual([expect.objectContaining({ active: false, revision: 2 })]);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'revoked' }),
    );
  });

  it('quarantines corrupt state instead of granting access', () => {
    const filePath = temporaryFile();
    fs.writeFileSync(filePath, '{"version":1,"bindings":[{}]}', {
      mode: 0o600,
    });
    expect(
      () => new JsonChannelIdentityRegistryV1({ filePath, audit: vi.fn() }),
    ).toThrow('registry was corrupt');
    expect(fs.existsSync(filePath)).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(filePath))
        .some((name) => name.includes('.corrupt-')),
    ).toBe(true);
  });

  it('does not persist an authorization when its audit record fails', async () => {
    const filePath = temporaryFile();
    const registry = new JsonChannelIdentityRegistryV1({
      filePath,
      audit: vi.fn().mockRejectedValue(new Error('audit unavailable')),
    });
    await expect(registry.bind(binding)).rejects.toThrow('audit unavailable');
    await expect(registry.resolve(binding)).resolves.toBeNull();
    expect(
      new JsonChannelIdentityRegistryV1({ filePath, audit: vi.fn() }).list(),
    ).toEqual([]);
  });
});
