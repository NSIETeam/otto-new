/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonChannelMessageDedupJournal } from './jsonChannelMessageJournal.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function file(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'otto-channel-journal-'));
  roots.push(root);
  return path.join(root, 'journal.json');
}

describe('JsonChannelMessageDedupJournal', () => {
  it('persists the claim before execution and refuses replay after restart', () => {
    const filePath = file();
    const first = new JsonChannelMessageDedupJournal({ filePath });
    expect(first.claim('channel:feishu:install-1:message-1')).toBe('claimed');

    const restarted = new JsonChannelMessageDedupJournal({ filePath });
    expect(restarted.claim('channel:feishu:install-1:message-1')).toBe(
      'processing',
    );
    expect(readFileSync(filePath, 'utf8')).not.toContain('message-1');
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('persists committed and unknown outcomes without storing raw identifiers', () => {
    const filePath = file();
    const journal = new JsonChannelMessageDedupJournal({ filePath });
    journal.claim('channel:wecom:install-1:message-2');
    journal.complete('channel:wecom:install-1:message-2');
    journal.claim('channel:lark:install-2:message-3');
    journal.unknown('channel:lark:install-2:message-3');

    const restarted = new JsonChannelMessageDedupJournal({ filePath });
    expect(restarted.claim('channel:wecom:install-1:message-2')).toBe(
      'committed',
    );
    expect(restarted.claim('channel:lark:install-2:message-3')).toBe(
      'unknown_outcome',
    );
    expect(readFileSync(filePath, 'utf8')).not.toContain('install-');
  });

  it('quarantines corruption and fails closed instead of forgetting dedup state', () => {
    const filePath = file();
    writeFileSync(filePath, '{broken', 'utf8');
    expect(
      () => new JsonChannelMessageDedupJournal({ filePath, now: () => 123 }),
    ).toThrow('was corrupt');
    expect(() => statSync(`${filePath}.corrupt-123`)).not.toThrow();
  });
});
