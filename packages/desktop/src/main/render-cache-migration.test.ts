/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDesktopRenderCachesForUpgrade } from './render-cache-migration.js';

const temporaryDirectories: string[] = [];

function createUserData(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-render-cache-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('desktop render cache upgrade migration', () => {
  it('moves recreatable Windows caches aside and writes a schema marker', () => {
    const userDataPath = createUserData();
    fs.mkdirSync(path.join(userDataPath, 'GPUCache'));
    fs.writeFileSync(path.join(userDataPath, 'GPUCache', 'shader.bin'), 'old');
    fs.mkdirSync(path.join(userDataPath, 'Code Cache'));
    fs.writeFileSync(path.join(userDataPath, 'Code Cache', 'code.bin'), 'old');
    fs.writeFileSync(path.join(userDataPath, 'enterprise-auth.json'), 'keep');

    const result = migrateDesktopRenderCachesForUpgrade({
      userDataPath,
      platform: 'win32',
      now: () => new Date('2026-08-31T13:00:00.000Z'),
    });

    expect(result).toMatchObject({
      completed: true,
      skipped: false,
      migrated: ['Code Cache', 'GPUCache'],
      failed: [],
    });
    expect(result.backupDirectory).not.toBeNull();
    expect(
      fs.readFileSync(
        path.join(result.backupDirectory!, 'GPUCache', 'shader.bin'),
        'utf8',
      ),
    ).toBe('old');
    expect(fs.existsSync(path.join(userDataPath, 'GPUCache'))).toBe(false);
    expect(fs.readFileSync(path.join(userDataPath, 'enterprise-auth.json'), 'utf8')).toBe(
      'keep',
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(userDataPath, 'desktop-render-cache-migration.json'),
          'utf8',
        ),
      ),
    ).toEqual({ schemaVersion: 1 });
  });

  it('runs only once and leaves caches created by the current version alone', () => {
    const userDataPath = createUserData();
    const first = migrateDesktopRenderCachesForUpgrade({
      userDataPath,
      platform: 'win32',
    });
    expect(first.completed).toBe(true);
    fs.mkdirSync(path.join(userDataPath, 'GPUCache'));
    fs.writeFileSync(path.join(userDataPath, 'GPUCache', 'current.bin'), 'current');

    const second = migrateDesktopRenderCachesForUpgrade({
      userDataPath,
      platform: 'win32',
    });

    expect(second).toMatchObject({
      completed: true,
      skipped: true,
      migrated: [],
      failed: [],
    });
    expect(
      fs.readFileSync(path.join(userDataPath, 'GPUCache', 'current.bin'), 'utf8'),
    ).toBe('current');
  });

  it('does not touch cache directories on other platforms', () => {
    const userDataPath = createUserData();
    fs.mkdirSync(path.join(userDataPath, 'GPUCache'));

    const result = migrateDesktopRenderCachesForUpgrade({
      userDataPath,
      platform: 'darwin',
    });

    expect(result).toMatchObject({ completed: true, skipped: true });
    expect(fs.existsSync(path.join(userDataPath, 'GPUCache'))).toBe(true);
    expect(
      fs.existsSync(
        path.join(userDataPath, 'desktop-render-cache-migration.json'),
      ),
    ).toBe(false);
  });
});
