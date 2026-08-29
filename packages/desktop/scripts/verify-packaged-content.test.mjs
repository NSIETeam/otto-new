/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import asar from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findForbiddenAsarEntries,
  MAX_APP_ASAR_BYTES,
  verifyPackagedContent,
} from './verify-packaged-content.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createArchive(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'otto-asar-gate-'));
  temporaryDirectories.push(root);
  const input = path.join(root, 'input');
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const target = path.join(input, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }),
  );
  const archive = path.join(root, 'app.asar');
  await asar.createPackage(input, archive);
  return archive;
}

describe('packaged content gate', () => {
  it('rejects sources, compiler output, tests, documentation and duplicate UI payloads', () => {
    const entries = [
      '/dist/main/index.js.map',
      '/node_modules/example/tests/parser.test.js',
      '/node_modules/example/docs/README.html',
      '/node_modules/@otto/native/target/release/otto_native.dll',
      '/node_modules/@otto/native/src/lib.rs',
      '/node_modules/@otto/native/Cargo.toml',
      '/node_modules/better-sqlite3/deps/sqlite3/sqlite3.c',
      '/node_modules/better-sqlite3/build/Release/obj/sqlite3.o',
      '/node_modules/pdf-parse/lib/pdf.js/v1.9.426/build/pdf.js',
      '/node_modules/playwright-core/lib/vite/traceViewer/index.html',
      '/node_modules/electron/dist/electron.exe',
    ];

    const violations = findForbiddenAsarEntries(entries);
    expect(violations.map(({ entry }) => entry)).toEqual(
      entries.map((entry) => entry.slice(1)),
    );
  });

  it('keeps only runtime artifacts that the application needs', () => {
    const entries = [
      '/dist/main/index.js',
      '/dist/renderer/index.html',
      '/node_modules/@otto/native/bin/win32-x64/otto-native.exe',
      '/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      '/node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js',
      '/node_modules/playwright-core/lib/server/browserType.js',
    ];

    expect(findForbiddenAsarEntries(entries)).toEqual([]);
    expect(MAX_APP_ASAR_BYTES).toBe(120 * 1024 * 1024);
  });

  it('audits a real asar archive and enforces its byte budget', async () => {
    const archive = await createArchive({
      'dist/main/index.js': 'console.log("otto")',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node':
        'native-placeholder',
    });

    const result = verifyPackagedContent(archive);
    expect(result.entryCount).toBeGreaterThan(0);
    expect(result.size).toBeGreaterThan(0);
    expect(() => verifyPackagedContent(archive, { maxBytes: 1 })).toThrow(
      'app.asar exceeds size budget',
    );
  });

  it('blocks a real asar archive containing source maps', async () => {
    const archive = await createArchive({
      'dist/main/index.js': 'console.log("otto")',
      'dist/main/index.js.map': '{}',
    });

    expect(() => verifyPackagedContent(archive)).toThrow(
      'app.asar contains 1 forbidden entries',
    );
  });
});
