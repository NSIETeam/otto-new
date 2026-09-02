/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationDraftVault } from './conversationDraftVault.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'otto-draft-vault-'));
  roots.push(root);
  return {
    root,
    vault: new ConversationDraftVault({
      directory: root,
      protect: (value) => Buffer.from(`protected:${value}`, 'utf8').toString('base64'),
      unprotect: (value) => {
        const clear = Buffer.from(value, 'base64').toString('utf8');
        if (!clear.startsWith('protected:')) throw new Error('tampered payload');
        return clear.slice('protected:'.length);
      },
    }),
  };
}

describe('ConversationDraftVault', () => {
  it('按账号范围加密保存并恢复草稿，磁盘不出现业务明文', async () => {
    const { root, vault } = await harness();
    await vault.save('server-a::org-a::account-a', {
      version: 1,
      repair: [{ issue: '会议室顶灯不亮', phone: '13800138000' }],
    });

    await expect(vault.load('server-a::org-a::account-a')).resolves.toEqual({
      version: 1,
      repair: [{ issue: '会议室顶灯不亮', phone: '13800138000' }],
    });
    const fileName = await vault.fileNameForTesting('server-a::org-a::account-a');
    const disk = await readFile(join(root, fileName), 'utf8');
    expect(disk).not.toContain('会议室顶灯不亮');
    expect(disk).not.toContain('13800138000');
  });

  it('严格隔离范围并拒绝篡改、超大或不可序列化内容', async () => {
    const { root, vault } = await harness();
    await vault.save('account-a', { value: 'a' });
    await expect(vault.load('account-b')).resolves.toBeNull();

    const fileName = await vault.fileNameForTesting('account-a');
    await writeFile(join(root, fileName), '{"version":1,"scopeHash":"bad","protectedPayload":"bad"}');
    await expect(vault.load('account-a')).rejects.toThrow(/scope|vault/i);
    await expect(vault.save('account-a', { value: 'x'.repeat(600_000) })).rejects.toThrow(/large/i);
    await expect(vault.save('account-a', { value: BigInt(1) })).rejects.toThrow(/serializable/i);
  });

  it('加密能力失败时不会降级写入明文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'otto-draft-vault-'));
    roots.push(root);
    const vault = new ConversationDraftVault({
      directory: root,
      protect: () => { throw new Error('safeStorage unavailable'); },
      unprotect: () => '',
    });
    await expect(vault.save('account-a', { secret: 'never-on-disk' })).rejects.toThrow(/safeStorage/i);
    await expect(vault.load('account-a')).resolves.toBeNull();
  });
});
