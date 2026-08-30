/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Atomic local persistence for Core recurring-task lifecycle state. The Core
 * package owns the state contract; server owns this storage implementation.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecurringTaskState, RecurringTaskStateStore } from 'otto-core';

const FILE_VERSION = 1;
const DEFAULT_FILE_NAME = 'resident-recurring-tasks.json';

interface PersistedRecurringTaskStatesV1 {
  version: 1;
  tasks: RecurringTaskState[];
}

export interface JsonRecurringTaskStateStoreOptions {
  filePath?: string;
  now?: () => number;
  onCorrupt?: (corruptPath: string, error: unknown) => void;
  /** Enterprise external effects must never reset state and replay on damage. */
  corruptPolicy?: 'quarantine-and-reset' | 'fail-closed';
  /** Test seam for the parent-directory durability barrier. */
  syncDirectory?: (directory: string) => void;
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === 'win32' &&
      ['EBADF', 'EINVAL', 'EISDIR', 'EPERM'].includes(code ?? '')
    ) {
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function recurringTaskStateFilePath(
  userDir = process.env.OTTO_USER_DIR?.trim() ||
    path.join(os.homedir(), '.otto-user'),
): string {
  return path.join(userDir, DEFAULT_FILE_NAME);
}

function isTaskState(value: unknown): value is RecurringTaskState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state['name'] === 'string' &&
    state['name'].trim().length > 0 &&
    typeof state['source'] === 'string' &&
    state['source'].trim().length > 0 &&
    Number.isSafeInteger(state['definitionVersion']) &&
    (state['definitionVersion'] as number) > 0 &&
    typeof state['nextRunAtMs'] === 'number' &&
    Number.isFinite(state['nextRunAtMs']) &&
    typeof state['updatedAtMs'] === 'number' &&
    Number.isFinite(state['updatedAtMs']) &&
    (state['lastCompletedInputVersion'] === undefined ||
      typeof state['lastCompletedInputVersion'] === 'string')
  );
}

function parseStateFile(text: string): RecurringTaskState[] {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('recurring task state root must be an object');
  }
  const root = parsed as Record<string, unknown>;
  if (root['version'] !== FILE_VERSION || !Array.isArray(root['tasks'])) {
    throw new Error('unsupported recurring task state file');
  }
  if (root['tasks'].length > 10_000 || !root['tasks'].every(isTaskState)) {
    throw new Error('invalid recurring task state entry');
  }
  const unique = new Map<string, RecurringTaskState>();
  for (const state of root['tasks']) {
    const current = unique.get(state.name);
    if (!current || current.updatedAtMs < state.updatedAtMs) {
      unique.set(state.name, { ...state });
    }
  }
  return [...unique.values()];
}

export class JsonRecurringTaskStateStore implements RecurringTaskStateStore {
  private readonly states = new Map<string, RecurringTaskState>();
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly onCorrupt: (corruptPath: string, error: unknown) => void;
  private readonly corruptPolicy: 'quarantine-and-reset' | 'fail-closed';
  private readonly syncDirectory: (directory: string) => void;

  constructor(options: JsonRecurringTaskStateStoreOptions = {}) {
    this.filePath = options.filePath ?? recurringTaskStateFilePath();
    this.now = options.now ?? Date.now;
    this.onCorrupt = options.onCorrupt ?? (() => undefined);
    this.corruptPolicy = options.corruptPolicy ?? 'quarantine-and-reset';
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
    this.load();
  }

  get(name: string): RecurringTaskState | undefined {
    const state = this.states.get(name);
    return state ? { ...state } : undefined;
  }

  put(state: RecurringTaskState): void {
    if (!isTaskState(state)) throw new Error('invalid recurring task state');
    this.states.set(state.name, { ...state });
    this.flush();
  }

  list(): RecurringTaskState[] {
    return [...this.states.values()]
      .map((state) => ({ ...state }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Atomically rewrites current state to prove the runtime directory is writable. */
  verifyWritable(): void {
    this.flush();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const tasks = parseStateFile(fs.readFileSync(this.filePath, 'utf8'));
      for (const state of tasks) this.states.set(state.name, state);
    } catch (error) {
      if (this.corruptPolicy === 'fail-closed') {
        this.onCorrupt(this.filePath, error);
        throw new Error(
          `recurring task state is unreadable or corrupt: ${this.filePath}`,
          { cause: error },
        );
      }
      const corruptPath = `${this.filePath}.corrupt-${this.now()}`;
      try {
        fs.renameSync(this.filePath, corruptPath);
      } catch {
        // Preserve the original error. A read-only/colliding path is reported
        // through the callback without overwriting the suspect file.
      }
      this.onCorrupt(corruptPath, error);
      this.states.clear();
    }
  }

  private flush(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const payload: PersistedRecurringTaskStatesV1 = {
      version: FILE_VERSION,
      tasks: this.list(),
    };
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      // The temporary file was fsynced before rename. Fsync the final inode
      // after chmod and then the parent directory so a power loss cannot roll
      // the checkpoint back to an older directory entry.
      // Windows rejects fsync on a read-only descriptor; r+ is safe because no
      // bytes are modified and also works for the Linux production runtime.
      const finalDescriptor = fs.openSync(this.filePath, 'r+');
      try {
        fs.fsyncSync(finalDescriptor);
      } finally {
        fs.closeSync(finalDescriptor);
      }
      this.syncDirectory(directory);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Best effort only; the next write uses a unique temporary path.
      }
      throw error;
    }
  }
}
