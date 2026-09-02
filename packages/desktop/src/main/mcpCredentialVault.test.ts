/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
});
