/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

export const MAX_APP_ASAR_BYTES = 120 * 1024 * 1024;

export const FORBIDDEN_ASAR_PREFIXES = Object.freeze([
  'node_modules/@otto/native/target',
  'node_modules/@otto/native/src',
  'node_modules/@otto/native/node_modules',
  'node_modules/better-sqlite3/deps',
  'node_modules/better-sqlite3/src',
  'node_modules/better-sqlite3/build/Debug',
  'node_modules/better-sqlite3/build/Release/obj',
  'node_modules/better-sqlite3/build/Release/obj.target',
  'node_modules/better-sqlite3/build/deps',
  'node_modules/pdf-parse/lib/pdf.js/v1.9.426',
  'node_modules/pdf-parse/lib/pdf.js/v1.10.88',
  'node_modules/pdf-parse/lib/pdf.js/v2.0.550',
  'node_modules/playwright-core/lib/vite',
  'node_modules/otto-core/dist/src/utils/testUtils.js',
  'node_modules/otto-core/dist/src/utils/test-helpers.js',
  'node_modules/otto-server/dist/src/enterprise/fixtures',
  'node_modules/electron',
]);

const FORBIDDEN_DIRECTORY_NAMES = new Set([
  '__image_snapshots__',
  '__mocks__',
  '__tests__',
  'coverage',
  'doc',
  'docs',
  'example',
  'examples',
  'spec',
  'specs',
  'test',
  'tests',
]);

const FORBIDDEN_NATIVE_SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.gyp',
  '.gypi',
  '.h',
  '.hpp',
  '.ilk',
  '.o',
  '.obj',
  '.pdb',
  '.rs',
]);

const FORBIDDEN_BUILD_FILES = new Set([
  'binding.gyp',
  'cargo.lock',
  'cargo.toml',
]);

function normalizeAsarEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '');
}

export function findForbiddenAsarEntries(entries) {
  const violations = [];
  for (const originalEntry of entries) {
    const entry = normalizeAsarEntry(originalEntry);
    const lowerEntry = entry.toLowerCase();
    const segments = lowerEntry.split('/');
    const basename = segments.at(-1) ?? '';
    const extension = path.posix.extname(basename);

    const reason = FORBIDDEN_ASAR_PREFIXES.find((prefix) => {
      const lowerPrefix = prefix.toLowerCase();
      return (
        lowerEntry === lowerPrefix || lowerEntry.startsWith(`${lowerPrefix}/`)
      );
    });
    if (reason) {
      violations.push({ entry, reason: `forbidden prefix: ${reason}` });
      continue;
    }
    if (lowerEntry.endsWith('.map')) {
      violations.push({ entry, reason: 'source map' });
      continue;
    }
    if (segments.some((segment) => FORBIDDEN_DIRECTORY_NAMES.has(segment))) {
      violations.push({ entry, reason: 'test/documentation directory' });
      continue;
    }
    if (
      segments.some(
        (segment, index) =>
          segment === 'target' &&
          ['debug', 'release'].includes(segments[index + 1]),
      )
    ) {
      violations.push({ entry, reason: 'native compiler target directory' });
      continue;
    }
    if (FORBIDDEN_NATIVE_SOURCE_EXTENSIONS.has(extension)) {
      violations.push({ entry, reason: 'native source/intermediate file' });
      continue;
    }
    if (
      FORBIDDEN_BUILD_FILES.has(basename) ||
      basename === '.last_build' ||
      /\.d\.(?:cts|mts|ts)$/u.test(basename) ||
      /^tsconfig(?:\..+)?\.json$/u.test(basename)
    ) {
      violations.push({ entry, reason: 'build configuration file' });
    }
  }
  return violations;
}

export function verifyPackagedContent(
  archivePath,
  { maxBytes = MAX_APP_ASAR_BYTES } = {},
) {
  if (!existsSync(archivePath)) {
    throw new Error(`app.asar not found: ${archivePath}`);
  }
  if (lstatSync(archivePath).isSymbolicLink()) {
    throw new Error(`app.asar must not be a symbolic link: ${archivePath}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`invalid app.asar size budget: ${maxBytes}`);
  }

  const size = statSync(archivePath).size;
  if (size > maxBytes) {
    throw new Error(
      `app.asar exceeds size budget: ${size} bytes > ${maxBytes} bytes`,
    );
  }

  const entries = asar.listPackage(archivePath);
  const violations = findForbiddenAsarEntries(entries);
  if (violations.length > 0) {
    const preview = violations
      .slice(0, 20)
      .map(({ entry, reason }) => `${entry} (${reason})`)
      .join('\n- ');
    const remainder =
      violations.length > 20
        ? `\n- ... and ${violations.length - 20} more`
        : '';
    throw new Error(
      `app.asar contains ${violations.length} forbidden entries:\n- ${preview}${remainder}`,
    );
  }

  return { size, entryCount: entries.length };
}

function main() {
  const archiveArgument = process.argv[2];
  if (!archiveArgument) {
    throw new Error(
      'usage: verify-packaged-content.mjs <app.asar> [--max-bytes <bytes>]',
    );
  }
  const maxBytesIndex = process.argv.indexOf('--max-bytes');
  const maxBytes =
    maxBytesIndex === -1
      ? MAX_APP_ASAR_BYTES
      : Number(process.argv[maxBytesIndex + 1]);
  const archivePath = path.resolve(process.cwd(), archiveArgument);
  const result = verifyPackagedContent(archivePath, { maxBytes });
  console.log(
    `[packaged-content] verified ${result.entryCount} entries, ${result.size} bytes`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
