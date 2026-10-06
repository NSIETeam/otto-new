/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { finished } from 'node:stream/promises';
import asar from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readServerNotice,
  SERVER_NOTICE_ASAR_PATH,
} from '../../../scripts/server-notice.mjs';
import {
  findForbiddenAsarEntries,
  MAX_APP_ASAR_BYTES,
  verifyPackagedContent,
} from './verify-packaged-content.mjs';

const temporaryDirectories = [];
const reviewedNotice = readServerNotice(
  path.resolve(import.meta.dirname, '../../..'),
);

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
  const archiveWriteStream = await asar.createPackage(input, archive);
  await finished(archiveWriteStream);
  return archive;
}

describe('packaged content gate', () => {
  it('rejects sources, compiler output, tests, documentation and duplicate UI payloads', () => {
    const entries = [
      '/dist/main/index.js.map',
      '/node_modules/example/tests/parser.test.js',
      '/node_modules/example/spec/parser.spec.js',
      '/node_modules/example/__mocks__/fs.js',
      '/node_modules/example/src/__image_snapshots__/render-1-snap.png',
      '/node_modules/example/docs/README.html',
      '/node_modules/@otto/native/target/release/otto_native.dll',
      '/node_modules/@otto/native/src/lib.rs',
      '/node_modules/@otto/native/Cargo.toml',
      '/node_modules/better-sqlite3/deps/sqlite3/sqlite3.c',
      '/node_modules/better-sqlite3/build/Release/obj/sqlite3.o',
      '/node_modules/pdf-parse/lib/pdf.js/v1.9.426/build/pdf.js',
      '/node_modules/playwright-core/lib/vite/traceViewer/index.html',
      '/node_modules/otto-core/dist/src/utils/testUtils.js',
      '/node_modules/otto-core/dist/src/utils/test-helpers.js',
      '/node_modules/otto-server/dist/src/enterprise/fixtures/v1.9.13-schema23/fixture-metadata.json',
      '/node_modules/electron/dist/electron.exe',
      '/node_modules/example/index.d.cts',
      '/node_modules/example/index.d.mts',
      '/node_modules/example/tsconfig.build.json',
      '/node_modules/otto-core/dist/.last_build',
      '/dist/main/update-core.test.js',
      '/node_modules/runtime-lib/parser.spec.cjs',
      '/dist/main/index.ts',
      '/dist/renderer/App.tsx',
      '/node_modules/runtime-lib/index.mts',
      '/node_modules/runtime-lib/index.cts',
      '/node_modules/runtime-lib/tsconfig.tsbuildinfo',
      '/junit.xml',
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
      '/node_modules/otto-server/dist/src/taskRequirements.js',
      '/node_modules/otto-server/NOTICE',
      '/node_modules/runtime-lib/LICENSE.md',
      '/node_modules/otto-core/skills-seed/writing/SKILL.md',
      '/node_modules/otto-core/skills-seed/writing/references/guide.md',
    ];

    expect(findForbiddenAsarEntries(entries)).toEqual([]);
    expect(MAX_APP_ASAR_BYTES).toBe(120 * 1024 * 1024);
  });

  it('rejects exact forbidden roots and compiler output outside known package prefixes', () => {
    const entries = [
      '/node_modules/@otto/native/src',
      '/node_modules/custom/target/debug/helper.bin',
      '/node_modules/custom/target/release/helper.bin',
      '/node_modules/custom/worker.rs',
    ];
    expect(findForbiddenAsarEntries(entries).map(({ entry }) => entry)).toEqual(
      entries.map((entry) => entry.slice(1)),
    );
    expect(
      findForbiddenAsarEntries([
        '/node_modules/custom/target/runtime/helper.js',
      ]),
    ).toEqual([]);
  });

  it('keeps violation previews bounded while reporting the complete count', async () => {
    const archive = await createArchive(
      Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [
          `dist/fixture-${index}.js.map`,
          '{}',
        ]),
      ),
    );
    expect(() => verifyPackagedContent(archive)).toThrow(
      'contains 25 forbidden entries',
    );
    expect(() => verifyPackagedContent(archive)).toThrow('... and 5 more');
  });

  it('audits a real asar archive and enforces its byte budget', async () => {
    const archive = await createArchive({
      'dist/main/index.js': 'console.log("otto")',
      [SERVER_NOTICE_ASAR_PATH]: reviewedNotice,
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

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid byte budgets before reading ASAR contents (%s)',
    async (maxBytes) => {
      const archive = await createArchive({
        [SERVER_NOTICE_ASAR_PATH]: reviewedNotice,
      });
      expect(() => verifyPackagedContent(archive, { maxBytes })).toThrow(
        'invalid app.asar size budget',
      );
    },
  );

  it('executes the real gate CLI, preserving default/custom budgets and usage errors', async () => {
    const archive = await createArchive({
      [SERVER_NOTICE_ASAR_PATH]: reviewedNotice,
    });
    const verifier = path.join(
      import.meta.dirname,
      'verify-packaged-content.mjs',
    );
    const run = (args) =>
      spawnSync(process.execPath, [verifier, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      });
    for (const args of [
      [archive],
      [archive, '--max-bytes', String(MAX_APP_ASAR_BYTES)],
    ]) {
      const result = run(args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('[packaged-content] verified');
    }
    const missingArgument = run([]);
    expect(missingArgument.status).toBe(1);
    expect(missingArgument.stderr).toContain(
      'usage: verify-packaged-content.mjs',
    );
    const invalidBudget = run([archive, '--max-bytes', 'invalid']);
    expect(invalidBudget.status).toBe(1);
    expect(invalidBudget.stderr).toContain('invalid app.asar size budget');
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

  it('blocks a real asar archive missing the server third-party notice', async () => {
    const archive = await createArchive({
      'dist/main/index.js': 'console.log("otto")',
    });
    expect(() => verifyPackagedContent(archive)).toThrow(
      'missing required third-party NOTICE',
    );
  });

  it('blocks a real asar archive with a truncated or substituted notice', async () => {
    const archive = await createArchive({
      [SERVER_NOTICE_ASAR_PATH]: 'MIT License',
    });
    expect(() => verifyPackagedContent(archive)).toThrow(
      'differs from the reviewed source',
    );
  });

  it('accepts the complete notice across Windows and Unix checkout line endings', async () => {
    const archive = await createArchive({
      [SERVER_NOTICE_ASAR_PATH]: reviewedNotice
        .toString('utf8')
        .replace(/\r?\n/g, '\r\n'),
    });
    expect(verifyPackagedContent(archive).entryCount).toBeGreaterThan(0);
  });
});
