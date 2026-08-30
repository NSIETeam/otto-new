/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const GLOBAL_MEMORY_SECTION_HEADER = '## Otto Added Memories';

export interface GlobalMemoryDeduplication {
  content: string;
  before: number;
  after: number;
  removed: number;
}

interface AtomicTextFileHandle {
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface AtomicDirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicTextWriteOperations {
  stat(filePath: string): Promise<{ mode: number }>;
  open(
    filePath: string,
    flags: 'wx',
    mode: number,
  ): Promise<AtomicTextFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  openDirectory(directoryPath: string): Promise<AtomicDirectoryHandle>;
}

const DEFAULT_ATOMIC_WRITE_OPERATIONS: AtomicTextWriteOperations = {
  stat: async (filePath) => fs.stat(filePath),
  open: async (filePath, flags, mode) => fs.open(filePath, flags, mode),
  rename: async (from, to) => fs.rename(from, to),
  unlink: async (filePath) => fs.unlink(filePath),
  openDirectory: async (directoryPath) => fs.open(directoryPath, 'r'),
};

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  'EINVAL',
  'EPERM',
  'EISDIR',
  'ENOTSUP',
]);

function isUnsupportedWindowsDirectorySync(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error.code)
  );
}

async function syncParentDirectory(
  filePath: string,
  operations: AtomicTextWriteOperations,
): Promise<void> {
  let handle: AtomicDirectoryHandle | undefined;
  try {
    handle = await operations.openDirectory(path.dirname(filePath));
    await handle.sync();
  } catch (error) {
    // Node/Windows may reject opening or syncing directory handles. Ignore only
    // the documented compatibility-shaped errors; all other failures surface.
    if (!isUnsupportedWindowsDirectorySync(error)) throw error;
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

/**
 * Remove only later duplicate list items from the Otto memory section.
 * Headings, prose, comments, whitespace and newline style are preserved.
 */
export function deduplicateGlobalMemoryContent(
  raw: string,
): GlobalMemoryDeduplication {
  const headerIndex = raw.indexOf(GLOBAL_MEMORY_SECTION_HEADER);
  if (headerIndex < 0) {
    return { content: raw, before: 0, after: 0, removed: 0 };
  }

  const sectionStart = headerIndex + GLOBAL_MEMORY_SECTION_HEADER.length;
  const afterHeader = raw.slice(sectionStart);
  const nextSectionMatch = /(?:\r\n|\n|\r)##[ \t]+/.exec(afterHeader);
  const sectionEnd =
    nextSectionMatch === null
      ? raw.length
      : sectionStart + nextSectionMatch.index;
  const sectionBody = raw.slice(sectionStart, sectionEnd);

  // Keep separators as tokens so removing a duplicate line does not normalize
  // LF/CRLF or rewrite surrounding user-authored content.
  const lineTokens = sectionBody.split(/(\r\n|\n|\r)/);
  const seenFacts = new Set<string>();
  let before = 0;
  let removed = 0;

  for (let index = 0; index < lineTokens.length; index += 2) {
    const line = lineTokens[index] ?? '';
    const match = /^\s*-\s+(\S(?:.*\S)?)\s*$/.exec(line);
    if (match === null) continue;

    const fact = match[1].trim();
    before += 1;
    if (!seenFacts.has(fact)) {
      seenFacts.add(fact);
      continue;
    }

    lineTokens[index] = '';
    if (index + 1 < lineTokens.length) {
      lineTokens[index + 1] = '';
    }
    removed += 1;
  }

  if (removed === 0) {
    return { content: raw, before, after: before, removed: 0 };
  }

  return {
    content:
      raw.slice(0, sectionStart) + lineTokens.join('') + raw.slice(sectionEnd),
    before,
    after: before - removed,
    removed,
  };
}

/**
 * Durable same-directory replacement. Before rename, any failure closes and
 * removes the temporary file while preserving the old destination. After a
 * successful rename, parent-directory fsync/close failures are surfaced
 * fail-closed; callers may safely retry the idempotent replacement to confirm
 * durability even though the new destination may already be visible.
 */
export async function atomicWriteTextFile(
  filePath: string,
  content: string,
  operations: AtomicTextWriteOperations = DEFAULT_ATOMIC_WRITE_OPERATIONS,
): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await operations.stat(filePath)).mode & 0o777;
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }

  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: AtomicTextFileHandle | undefined;

  try {
    handle = await operations.open(temporaryPath, 'wx', mode || 0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await operations.rename(temporaryPath, filePath);
    await syncParentDirectory(filePath, operations);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await operations.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
