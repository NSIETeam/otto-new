/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 对话动作草稿由 Electron main 独占持久化。业务负载整体经过 safeStorage
 * 后才写盘；scope 只以 SHA-256 摘要出现在文件名和文件头中。
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_SCOPE_LENGTH = 1_024;
const MAX_CLEAR_BYTES = 512 * 1_024;
const MAX_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_PROTECTED_LENGTH = 1_500_000;

interface VaultFile {
  version: 1;
  scopeHash: string;
  protectedPayload: string;
}

export interface ConversationDraftVaultOptions {
  directory: string;
  protect(value: string): string;
  unprotect(value: string): string;
}

function validateScope(scope: string): string {
  const value = scope.trim();
  const hasControlCharacter = Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f);
  if (!value || value.length > MAX_SCOPE_LENGTH || hasControlCharacter) {
    throw new Error('invalid conversation draft vault scope');
  }
  return value;
}

function scopeHash(scope: string): string {
  return createHash('sha256').update(scope).digest('hex');
}

export class ConversationDraftVault {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ConversationDraftVaultOptions) {}

  private identity(scopeInput: string): { hash: string; path: string } {
    const hash = scopeHash(validateScope(scopeInput));
    return { hash, path: join(this.options.directory, `conversation-drafts-${hash}.json`) };
  }

  async fileNameForTesting(scope: string): Promise<string> {
    return this.identity(scope).path.split(/[\\/]/u).at(-1)!;
  }

  async load(scope: string): Promise<unknown | null> {
    await this.tail;
    const identity = this.identity(scope);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(identity.path, 'r');
      const stat = await handle.stat();
      if (stat.size > MAX_FILE_BYTES) throw new Error('conversation draft vault is too large');
      const parsed = JSON.parse(await handle.readFile('utf8')) as Partial<VaultFile>;
      if (
        parsed.version !== 1
        || parsed.scopeHash !== identity.hash
        || typeof parsed.protectedPayload !== 'string'
        || !parsed.protectedPayload
        || parsed.protectedPayload.length > MAX_PROTECTED_LENGTH
      ) {
        throw new Error('invalid conversation draft vault scope or payload');
      }
      const clear = this.options.unprotect(parsed.protectedPayload);
      if (Buffer.byteLength(clear, 'utf8') > MAX_CLEAR_BYTES) {
        throw new Error('conversation draft vault clear payload is too large');
      }
      return JSON.parse(clear) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async save(scope: string, payload: unknown): Promise<void> {
    const identity = this.identity(scope);
    let clear: string;
    try {
      clear = JSON.stringify(payload);
    } catch {
      throw new Error('conversation draft payload must be JSON serializable');
    }
    if (clear === undefined) throw new Error('conversation draft payload must be JSON serializable');
    if (Buffer.byteLength(clear, 'utf8') > MAX_CLEAR_BYTES) {
      throw new Error('conversation draft payload is too large');
    }
    const operation = this.tail.then(async () => {
      const protectedPayload = this.options.protect(clear);
      if (!protectedPayload || protectedPayload.length > MAX_PROTECTED_LENGTH) {
        throw new Error('protected conversation draft payload is invalid or too large');
      }
      const body: VaultFile = { version: 1, scopeHash: identity.hash, protectedPayload };
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const temp = `${identity.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temp, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, identity.path);
    });
    this.tail = operation.catch(() => undefined);
    await operation;
  }

  async remove(scope: string): Promise<void> {
    const identity = this.identity(scope);
    const operation = this.tail.then(async () => {
      try {
        await unlink(identity.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
    this.tail = operation.catch(() => undefined);
    await operation;
  }
}
