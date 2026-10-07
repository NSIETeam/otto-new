/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import asar from '@electron/asar';
import {
  findForbiddenAsarEntries,
  verifyPackagedContent,
} from './verify-packaged-content.mjs';
import {
  readServerNotice,
  SERVER_NOTICE_ASAR_PATH,
} from '../../../scripts/server-notice.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const require = createRequire(import.meta.url);
const vendor = 'vendor/hpke-rs-libcrux-0.6.1';
const sourceFiles = [
  'Cargo.toml',
  'Cargo.toml.orig',
  'src/lib.rs',
  'benches/bench_hkdf.rs',
  'benches/bench_p256.rs',
  'benches/bench_x25519.rs',
];
const notices = ['LICENSE-MPL-2.0.txt', 'NOTICE.md'];

async function dependencyFilter(platform) {
  const desktop = JSON.parse(
    await readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
  );
  const {
    doMergeConfigs,
  } = require('app-builder-lib/out/util/config/config.js');
  const {
    getNodeModuleFileMatcher,
  } = require('app-builder-lib/out/fileMatcher.js');
  const config = doMergeConfigs([desktop.build]);
  return getNodeModuleFileMatcher(
    desktopRoot,
    path.join(desktopRoot, 'release/vendor-contract'),
    (value) => value,
    config[platform],
    { config, debugLogger: { isEnabled: false } },
  ).createFilter();
}

describe('native vendor packaging contract', () => {
  it.each(['mac', 'win'])(
    'filters build-only Rust sources with real normalized %s dependency matchers',
    async (platform) => {
      const filter = await dependencyFilter(platform);
      const metadata = { isDirectory: () => false };
      for (const prefix of [
        'node_modules',
        'node_modules/otto-server/node_modules',
      ]) {
        for (const filename of sourceFiles) {
          const entry = `${prefix}/@otto/native/${vendor}/${filename}`;
          expect(filter(path.join(desktopRoot, entry), metadata), entry).toBe(
            false,
          );
        }
      }
    },
  );

  it.each(['mac', 'win'])(
    'keeps actual vendor license texts and required JavaScript with %s dependency matchers',
    async (platform) => {
      const filter = await dependencyFilter(platform);
      const metadata = { isDirectory: () => false };
      for (const filename of notices) {
        const entry = `node_modules/@otto/native/${vendor}/${filename}`;
        expect(filter(path.join(desktopRoot, entry), metadata), entry).toBe(
          true,
        );
        expect(
          (await readFile(path.join(repoRoot, 'otto-native', vendor, filename)))
            .length,
        ).toBeGreaterThan(100);
      }
      for (const entry of [
        'node_modules/@otto/native/package.json',
        'node_modules/@otto/native/dist/index.js',
        'node_modules/other-library/vendor/runtime.js',
        'node_modules/other-library/vendor/LICENSE',
      ]) {
        expect(filter(path.join(desktopRoot, entry), metadata), entry).toBe(
          true,
        );
      }
    },
  );

  it('keeps the content gate rejecting vendored compiler inputs rather than waiving them', () => {
    const entries = sourceFiles
      .filter((file) => file !== 'Cargo.toml.orig')
      .map((file) => `node_modules/@otto/native/${vendor}/${file}`);
    expect(findForbiddenAsarEntries(entries).map((item) => item.entry)).toEqual(
      entries,
    );
  });

  it.each(['mac', 'win'])(
    'builds and audits a real filtered %s archive retaining full vendor licenses',
    async (platform) => {
      const filter = await dependencyFilter(platform);
      const metadata = { isDirectory: () => false };
      const root = await mkdtemp(path.join(os.tmpdir(), 'otto-vendor-asar-'));
      try {
        const input = path.join(root, 'input');
        const retained = new Map([
          [SERVER_NOTICE_ASAR_PATH, readServerNotice(repoRoot)],
        ]);
        for (const filename of [...sourceFiles, ...notices]) {
          const entry = `node_modules/@otto/native/${vendor}/${filename}`;
          const bytes = await readFile(
            path.join(repoRoot, 'otto-native', vendor, filename),
          );
          if (filter(path.join(desktopRoot, entry), metadata))
            retained.set(entry, bytes);
        }
        for (const [entry, bytes] of retained) {
          const target = path.join(input, entry);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, bytes);
        }
        const archive = path.join(root, 'app.asar');
        await finished(await asar.createPackage(input, archive));
        expect(verifyPackagedContent(archive).entryCount).toBeGreaterThan(0);
        for (const filename of notices) {
          const entry = `node_modules/@otto/native/${vendor}/${filename}`;
          expect(asar.extractFile(archive, path.normalize(entry))).toEqual(
            retained.get(entry),
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
