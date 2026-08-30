/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ChannelMessageClaimState,
  ChannelMessageDedupJournal,
} from './channelTaskControl.js';

interface JournalEntry {
  keyHash: string;
  state: ChannelMessageClaimState;
  updatedAtMs: number;
}

interface JournalFileV1 {
  version: 1;
  entries: JournalEntry[];
}

export interface JsonChannelMessageJournalOptions {
  filePath?: string;
  now?: () => number;
  maxEntries?: number;
  retentionMs?: number;
}

function defaultPath(): string {
  const userDir = process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user');
  return path.join(userDir, 'channel-task-message-journal.json');
}

function keyHash(recordKey: string): string {
  if (!recordKey.trim() || recordKey.length > 1_000) throw new Error('invalid channel message journal key');
  return createHash('sha256').update(recordKey, 'utf8').digest('hex');
}

export class JsonChannelMessageDedupJournal implements ChannelMessageDedupJournal {
  private readonly entries = new Map<string, JournalEntry>();
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly retentionMs: number;

  constructor(options: JsonChannelMessageJournalOptions = {}) {
    this.filePath = options.filePath ?? defaultPath();
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 100 || this.maxEntries > 100_000) {
      throw new Error('channel message journal maxEntries is invalid');
    }
    this.load();
  }

  claim(recordKey: string): 'claimed' | ChannelMessageClaimState {
    const hash = keyHash(recordKey);
    const existing = this.entries.get(hash);
    if (existing) return existing.state;
    if ([...this.entries.values()].filter((entry) => entry.state === 'processing').length >= this.maxEntries) {
      throw new Error('channel message journal has too many unresolved operations');
    }
    this.entries.set(hash, { keyHash: hash, state: 'processing', updatedAtMs: this.now() });
    this.flush();
    return 'claimed';
  }

  complete(recordKey: string): void {
    this.update(recordKey, 'committed');
  }

  unknown(recordKey: string): void {
    this.update(recordKey, 'unknown_outcome');
  }

  private update(recordKey: string, state: ChannelMessageClaimState): void {
    const hash = keyHash(recordKey);
    if (!this.entries.has(hash)) throw new Error('channel message journal key was not claimed');
    this.entries.set(hash, { keyHash: hash, state, updatedAtMs: this.now() });
    this.flush();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    let parsed: JournalFileV1;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as JournalFileV1;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 100_000) {
        throw new Error('unsupported channel message journal');
      }
      for (const entry of parsed.entries) {
        if (!/^[a-f0-9]{64}$/u.test(entry.keyHash)
          || !['processing', 'committed', 'unknown_outcome'].includes(entry.state)
          || !Number.isFinite(entry.updatedAtMs)) {
          throw new Error('invalid channel message journal entry');
        }
        this.entries.set(entry.keyHash, { ...entry });
      }
      this.prune();
    } catch (error) {
      const quarantine = `${this.filePath}.corrupt-${this.now()}`;
      try { fs.renameSync(this.filePath, quarantine); } catch { /* preserve suspect file */ }
      this.entries.clear();
      throw new Error(`channel message journal was corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    const processing = [...this.entries.values()]
      .filter((entry) => entry.state === 'processing');
    if (processing.length > this.maxEntries) {
      throw new Error('channel message journal exceeds unresolved operation limit');
    }
    const completed = [...this.entries.values()]
      .filter((entry) => entry.state !== 'processing' && entry.updatedAtMs >= cutoff)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, this.maxEntries - processing.length);
    this.entries.clear();
    for (const entry of [...processing, ...completed]) this.entries.set(entry.keyHash, entry);
  }

  private flush(): void {
    this.prune();
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      const payload: JournalFileV1 = { version: 1, entries: [...this.entries.values()] };
      fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
  }
}
