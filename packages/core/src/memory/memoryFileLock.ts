/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/**
 * Process-local serialization for read/modify/replace operations on a memory
 * file. User writes and background maintenance must share this boundary, or a
 * maintenance rewrite can overwrite a fact saved at the same time.
 */
const memoryFileWriteChains = new Map<string, Promise<void>>();

function lockKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function withMemoryFileWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = lockKey(filePath);
  const previous = memoryFileWriteChains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );

  memoryFileWriteChains.set(key, settled);
  try {
    return await run;
  } finally {
    if (memoryFileWriteChains.get(key) === settled) {
      memoryFileWriteChains.delete(key);
    }
  }
}
