/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpCredentialVault } from './mcpCredentialVault.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCP encrypted credential vault', () => {
  it('persists ciphertext only and exposes names plus environment aliases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-vault-'));
    roots.push(root);
    const file = join(root, 'mcp-credentials.json');
    const vault = new McpCredentialVault({
      filePath: file,
      protect: (value) => Buffer.from(`protected:${value}`).toString('base64'),
      unprotect: (value) => Buffer.from(value, 'base64').toString('utf8').slice('protected:'.length),
    });

    const saved = await vault.set('github-mcp', 'GITHUB_TOKEN', 'top-secret');

    expect(saved.environmentAlias).toMatch(/^OTTO_MCP_CREDENTIAL_[A-F0-9]{32}$/);
    expect(await vault.list()).toEqual([{
      serverName: 'github-mcp',
      variableName: 'GITHUB_TOKEN',
      environmentAlias: saved.environmentAlias,
    }]);
    expect(await vault.runtimeEnvironment()).toEqual({
      [saved.environmentAlias]: 'top-secret',
    });
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('top-secret');
    expect(onDisk).not.toContain('protected:top-secret');
  });

  it('rejects invalid variable names and never returns plaintext in summaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-vault-'));
    roots.push(root);
    const vault = new McpCredentialVault({
      filePath: join(root, 'mcp-credentials.json'),
      protect: (value) => `enc:${value}`,
      unprotect: (value) => value.slice(4),
    });
    await expect(vault.set('safe', 'BAD-NAME', 'secret')).rejects.toThrow(/variable name/i);
    await vault.set('safe', 'API_KEY', 'secret');
    expect(JSON.stringify(await vault.list())).not.toContain('secret');
  });

  it('rejects a tampered environment alias before decrypting or populating process environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-vault-'));
    roots.push(root);
    const file = join(root, 'mcp-credentials.json');
    let unprotectCalls = 0;
    const vault = new McpCredentialVault({
      filePath: file,
      protect: (value) => Buffer.from(value).toString('base64'),
      unprotect: (value) => {
        unprotectCalls += 1;
        return Buffer.from(value, 'base64').toString('utf8');
      },
    });
    await vault.set('github-mcp', 'GITHUB_TOKEN', 'top-secret');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      credentials: Array<{ environmentAlias: string }>;
    };
    parsed.credentials[0]!.environmentAlias = 'PATH';
    writeFileSync(file, JSON.stringify(parsed));

    await expect(vault.runtimeEnvironment()).rejects.toThrow(/tamper|alias|vault/i);
    expect(unprotectCalls).toBe(0);
  });

  it('caps plaintext secret size and encrypted vault file size', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-vault-'));
    roots.push(root);
    const file = join(root, 'mcp-credentials.json');
    const vault = new McpCredentialVault({
      filePath: file,
      protect: (value) => `enc:${value}`,
      unprotect: (value) => value.slice(4),
    });
    await expect(vault.set('safe', 'API_KEY', 'x'.repeat(65_537))).rejects.toThrow(/large|size|credential/i);
    writeFileSync(file, ' '.repeat(1_048_577));
    await expect(vault.list()).rejects.toThrow(/large|size|vault/i);
  });

  it('serializes concurrent writes without losing credentials or exposing plaintext', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-vault-'));
    roots.push(root);
    const file = join(root, 'mcp-credentials.json');
    const vault = new McpCredentialVault({
      filePath: file,
      protect: (value) => Buffer.from(`cipher:${value}`).toString('base64'),
      unprotect: (value) => Buffer.from(value, 'base64').toString('utf8').slice(7),
    });
    await Promise.all(Array.from({ length: 32 }, (_, index) => (
      vault.set(`server-${index}`, `TOKEN_${index}`, `secret-${index}`)
    )));

    expect(await vault.list()).toHaveLength(32);
    expect(Object.keys(await vault.runtimeEnvironment())).toHaveLength(32);
    const disk = readFileSync(file, 'utf8');
    for (let index = 0; index < 32; index += 1) expect(disk).not.toContain(`secret-${index}`);
  });

  it('rejects duplicate identities and malformed protected values in a tampered vault', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-vault-'));
    roots.push(root);
    const file = join(root, 'mcp-credentials.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      credentials: [
        { serverName: 'safe', variableName: 'API_KEY', environmentAlias: 'fake', protectedValue: 'enc:a' },
        { serverName: 'safe', variableName: 'API_KEY', environmentAlias: 'fake', protectedValue: 42 },
      ],
    }));
    const vault = new McpCredentialVault({
      filePath: file,
      protect: (value) => `enc:${value}`,
      unprotect: (value) => value.slice(4),
    });
    await expect(vault.list()).rejects.toThrow(/vault|tamper|credential/i);
  });

  it('recovers the serialized write queue after one protection operation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-vault-'));
    roots.push(root);
    let fail = true;
    const vault = new McpCredentialVault({
      filePath: join(root, 'mcp-credentials.json'),
      protect: (value) => {
        if (fail) throw new Error('safeStorage unavailable');
        return Buffer.from(value).toString('base64');
      },
      unprotect: (value) => Buffer.from(value, 'base64').toString('utf8'),
    });
    await expect(vault.set('first', 'TOKEN', 'secret-one')).rejects.toThrow(/safeStorage/i);
    fail = false;
    await expect(vault.set('second', 'TOKEN', 'secret-two')).resolves.toMatchObject({ serverName: 'second' });
    expect(await vault.list()).toEqual([
      expect.objectContaining({ serverName: 'second', variableName: 'TOKEN' }),
    ]);
  });
});
