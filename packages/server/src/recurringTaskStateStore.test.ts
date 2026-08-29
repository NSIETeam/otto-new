import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonRecurringTaskStateStore } from './recurringTaskStateStore.js';

const temporaryRoots: string[] = [];

function temporaryFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-recurring-store-'));
  temporaryRoots.push(root);
  return path.join(root, 'state', 'tasks.json');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('JsonRecurringTaskStateStore', () => {
  it('atomically persists and restores task state with restrictive permissions', () => {
    const filePath = temporaryFile();
    const store = new JsonRecurringTaskStateStore({ filePath });
    store.put({
      name: 'daily-index', source: 'test', definitionVersion: 2,
      lastCompletedInputVersion: 'v4', nextRunAtMs: 20, updatedAtMs: 10,
    });

    expect(new JsonRecurringTaskStateStore({ filePath }).get('daily-index')).toEqual({
      name: 'daily-index', source: 'test', definitionVersion: 2,
      lastCompletedInputVersion: 'v4', nextRunAtMs: 20, updatedAtMs: 10,
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['tasks.json']);
  });

  it('preserves a corrupt file for diagnosis and starts with safe empty state', () => {
    const filePath = temporaryFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{broken', 'utf8');
    const corrupt: string[] = [];
    const store = new JsonRecurringTaskStateStore({
      filePath,
      now: () => 1234,
      onCorrupt: (corruptPath) => corrupt.push(corruptPath),
    });

    expect(store.list()).toEqual([]);
    expect(corrupt).toEqual([`${filePath}.corrupt-1234`]);
    expect(fs.readFileSync(`${filePath}.corrupt-1234`, 'utf8')).toBe('{broken');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects invalid state before touching the existing file', () => {
    const filePath = temporaryFile();
    const store = new JsonRecurringTaskStateStore({ filePath });
    store.put({
      name: 'valid', source: 'test', definitionVersion: 1,
      nextRunAtMs: 20, updatedAtMs: 10,
    });
    const before = fs.readFileSync(filePath, 'utf8');

    expect(() => store.put({
      name: '', source: 'test', definitionVersion: 1,
      nextRunAtMs: 20, updatedAtMs: 10,
    })).toThrow('invalid recurring task state');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('keeps the newest duplicate when reading a recovered state file', () => {
    const filePath = temporaryFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      tasks: [
        { name: 'same', source: 'test', definitionVersion: 1, nextRunAtMs: 2, updatedAtMs: 2 },
        { name: 'same', source: 'test', definitionVersion: 1, nextRunAtMs: 3, updatedAtMs: 3 },
      ],
    }), 'utf8');

    expect(new JsonRecurringTaskStateStore({ filePath }).get('same')?.nextRunAtMs).toBe(3);
  });
});
