/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Windows transparent BrowserWindows can inherit incompatible Chromium GPU
 * caches after an in-place Otto upgrade. Move only recreatable renderer caches
 * aside once, after the single-instance lock is held and before any window is
 * created. Account, enterprise session and conversation data are untouched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CACHE_SCHEMA_VERSION = 1;
const MARKER_FILE = 'desktop-render-cache-migration.json';
const CACHE_DIRECTORIES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
] as const;

export interface DesktopRenderCacheMigrationResult {
  completed: boolean;
  skipped: boolean;
  migrated: string[];
  failed: string[];
  backupDirectory: string | null;
}

export interface DesktopRenderCacheMigrationInput {
  userDataPath: string;
  platform: NodeJS.Platform;
  now?: () => Date;
}

function markerIsCurrent(markerPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
      schemaVersion?: unknown;
    };
    return (
      typeof parsed.schemaVersion === 'number' &&
      parsed.schemaVersion >= CACHE_SCHEMA_VERSION
    );
  } catch {
    return false;
  }
}

function backupId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function migrateDesktopRenderCachesForUpgrade({
  userDataPath,
  platform,
  now = () => new Date(),
}: DesktopRenderCacheMigrationInput): DesktopRenderCacheMigrationResult {
  if (platform !== 'win32') {
    return {
      completed: true,
      skipped: true,
      migrated: [],
      failed: [],
      backupDirectory: null,
    };
  }

  const markerPath = path.join(userDataPath, MARKER_FILE);
  if (markerIsCurrent(markerPath)) {
    return {
      completed: true,
      skipped: true,
      migrated: [],
      failed: [],
      backupDirectory: null,
    };
  }

  const backupDirectory = path.join(
    userDataPath,
    'cache-migrations',
    `render-cache-v${CACHE_SCHEMA_VERSION}-${backupId(now())}`,
  );
  const migrated: string[] = [];
  const failed: string[] = [];

  for (const directoryName of CACHE_DIRECTORIES) {
    const source = path.join(userDataPath, directoryName);
    if (!fs.existsSync(source)) continue;
    try {
      fs.mkdirSync(backupDirectory, { recursive: true });
      fs.renameSync(source, path.join(backupDirectory, directoryName));
      migrated.push(directoryName);
    } catch {
      failed.push(directoryName);
    }
  }

  if (failed.length > 0) {
    return {
      completed: false,
      skipped: false,
      migrated,
      failed,
      backupDirectory: migrated.length > 0 ? backupDirectory : null,
    };
  }

  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION })}\n`,
      'utf8',
    );
  } catch {
    return {
      completed: false,
      skipped: false,
      migrated,
      failed: ['migration-marker'],
      backupDirectory: migrated.length > 0 ? backupDirectory : null,
    };
  }

  return {
    completed: true,
    skipped: false,
    migrated,
    failed: [],
    backupDirectory: migrated.length > 0 ? backupDirectory : null,
  };
}
