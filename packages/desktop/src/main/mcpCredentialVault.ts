/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * MCP secrets owned by Electron main. Values are protected with safeStorage
 * before disk and never returned to renderer; renderer receives only aliases.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface StoredCredential {
  serverName: string;
  variableName: string;
  environmentAlias: string;
  protectedValue: string;
}

interface VaultFile {
  version: 1;
  credentials: StoredCredential[];
}

export interface McpCredentialSummary {
  serverName: string;
  variableName: string;
  environmentAlias: string;
}

export interface McpCredentialVaultOptions {
  filePath: string;
  protect(value: string): string;
  unprotect(value: string): string;
}

function validateServerName(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 200 || /[\u0000-\u001f]/.test(clean)) {
    throw new Error('invalid MCP server name');
  }
  return clean;
}

function validateVariableName(value: string): string {
  const clean = value.trim();
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(clean)) {
    throw new Error('invalid MCP credential variable name');
  }
  return clean;
}

function aliasFor(serverName: string, variableName: string): string {
  const suffix = createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(variableName)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
  return `OTTO_MCP_CREDENTIAL_${suffix}`;
}

export class McpCredentialVault {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: McpCredentialVaultOptions) {}

  private async read(): Promise<VaultFile> {
    try {
      const parsed = JSON.parse(await readFile(this.options.filePath, 'utf8')) as Partial<VaultFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.credentials)) throw new Error('invalid vault');
      return { version: 1, credentials: parsed.credentials };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, credentials: [] };
      throw error;
    }
  }

  private async write(value: VaultFile): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.options.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, this.options.filePath);
  }

  async set(
    serverNameInput: string,
    variableNameInput: string,
    secretValue: string,
  ): Promise<McpCredentialSummary> {
    const serverName = validateServerName(serverNameInput);
    const variableName = validateVariableName(variableNameInput);
    if (!secretValue) throw new Error('MCP credential value must not be empty');
    const environmentAlias = aliasFor(serverName, variableName);
    const summary = { serverName, variableName, environmentAlias };
    const operation = this.tail.then(async () => {
      const vault = await this.read();
      const credentials = vault.credentials.filter((item) =>
        item.serverName !== serverName || item.variableName !== variableName,
      );
      credentials.push({ ...summary, protectedValue: this.options.protect(secretValue) });
      await this.write({ version: 1, credentials });
    });
    this.tail = operation.catch(() => undefined);
    await operation;
    return summary;
  }

  async list(): Promise<McpCredentialSummary[]> {
    await this.tail;
    return (await this.read()).credentials.map(({ protectedValue: _protectedValue, ...summary }) => summary);
  }

  async remove(serverNameInput: string, variableNameInput: string): Promise<void> {
    const serverName = validateServerName(serverNameInput);
    const variableName = validateVariableName(variableNameInput);
    const operation = this.tail.then(async () => {
      const vault = await this.read();
      await this.write({
        version: 1,
        credentials: vault.credentials.filter((item) =>
          item.serverName !== serverName || item.variableName !== variableName,
        ),
      });
    });
    this.tail = operation.catch(() => undefined);
    await operation;
  }

  /** Main-process/server-launch only. Never expose this method through preload. */
  async runtimeEnvironment(): Promise<Record<string, string>> {
    await this.tail;
    const output: Record<string, string> = {};
    for (const credential of (await this.read()).credentials) {
      output[credential.environmentAlias] = this.options.unprotect(credential.protectedValue);
    }
    return output;
  }
}
