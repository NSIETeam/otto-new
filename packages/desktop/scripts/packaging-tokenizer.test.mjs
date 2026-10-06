/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { findForbiddenAsarEntries } from './verify-packaged-content.mjs';
import {
  resolveMacInstallerBudget,
  resolveWindowsInstallerBudget,
} from './installer-size-budget.mjs';

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(desktopRoot, '../..');
const require = createRequire(import.meta.url);

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
    path.join(desktopRoot, 'release/tokenizer-contract'),
    (value) => value,
    config[platform],
    { config, debugLogger: { isEnabled: false } },
  ).createFilter();
}

describe('desktop tokenizer payload contract', () => {
  it.each(['mac', 'win'])(
    'omits duplicate rank bundles after real %s builder normalization',
    async (platform) => {
      const filter = await dependencyFilter(platform);
      const metadata = { isDirectory: () => false };
      for (const prefix of [
        'node_modules',
        'node_modules/otto-core/node_modules',
      ]) {
        for (const relative of [
          'dist/index.js',
          'dist/ranks/cl100k_base.js',
          'dist/ranks/o200k_base.js',
        ]) {
          const entry = `${prefix}/js-tiktoken/${relative}`;
          expect(filter(path.join(desktopRoot, entry), metadata), entry).toBe(
            false,
          );
        }
        for (const relative of [
          'package.json',
          'LICENSE',
          'dist/lite.js',
          'dist/chunk-VL2OQCWN.js',
        ]) {
          const entry = `${prefix}/js-tiktoken/${relative}`;
          expect(filter(path.join(desktopRoot, entry), metadata), entry).toBe(
            true,
          );
        }
      }
      // No broad index.js/ranks exclusion: other libraries and license text survive.
      for (const entry of [
        'node_modules/other-lib/dist/index.js',
        'node_modules/other-lib/dist/ranks/table.js',
        'node_modules/js-tiktoken/dist/ranks/LICENSE',
      ]) {
        expect(filter(path.join(desktopRoot, entry), metadata), entry).toBe(
          true,
        );
      }
    },
  );

  it('rejects accidentally reintroduced full tokenizer/rank bundles without rejecting lite or notices', () => {
    const redundant = [
      '/node_modules/js-tiktoken/dist/index.js',
      '/node_modules/otto-core/node_modules/js-tiktoken/dist/ranks/o200k_base.js',
    ];
    expect(
      findForbiddenAsarEntries(redundant).map(({ entry }) => entry),
    ).toEqual(redundant.map((entry) => entry.slice(1)));
    expect(
      findForbiddenAsarEntries([
        '/node_modules/js-tiktoken/dist/lite.js',
        '/node_modules/js-tiktoken/dist/chunk-VL2OQCWN.js',
        '/node_modules/js-tiktoken/LICENSE',
        '/node_modules/other-lib/dist/index.js',
        '/node_modules/other-lib/dist/ranks/table.js',
      ]),
    ).toEqual([]);
  });

  it('uses the real filtered lite package to encode/decode separately supplied ranks offline', async () => {
    const filter = await dependencyFilter('win');
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'otto-tokenizer-contract-'),
    );
    try {
      for (const name of ['js-tiktoken', 'base64-js']) {
        const sourceRoot = path.join(repoRoot, 'node_modules', name);
        const targetRoot = path.join(root, 'node_modules', name);
        await cp(sourceRoot, targetRoot, {
          recursive: true,
          filter: async (source) => {
            const stat = await lstat(source);
            return (
              stat.isDirectory() ||
              filter(
                path.join(
                  desktopRoot,
                  'node_modules',
                  name,
                  path.relative(sourceRoot, source),
                ),
                stat,
              )
            );
          },
        });
      }
      // Neither copied root can leak resolution into the checkout node_modules.
      const probe = path.join(root, 'probe.mjs');
      await mkdir(root, { recursive: true });
      await writeFile(
        probe,
        `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Tiktoken, getEncodingNameForModel } from 'js-tiktoken/lite';
globalThis.fetch = () => { throw new Error('Offline tokenizer probe must not fetch'); };
assert.equal(existsSync(new URL('./node_modules/js-tiktoken/dist/index.js', import.meta.url)), false);
assert.equal(existsSync(new URL('./node_modules/js-tiktoken/dist/ranks/cl100k_base.js', import.meta.url)), false);
assert.equal(getEncodingNameForModel('gpt-4'), 'cl100k_base');
const ranks = { pat_str: '[\\\\s\\\\S]', special_tokens: {}, bpe_ranks: '! 0 ' + Array.from({ length: 256 }, (_, byte) => Buffer.from([byte]).toString('base64')).join(' ') };
const tokenizer = new Tiktoken(ranks);
const text = '合成验收：Otto abc';
const encoded = tokenizer.encode(text);
assert.ok(encoded.length > 0);
assert.equal(tokenizer.decode(encoded), text);
console.log('filtered-lite-tokenizer: offline roundtrip passed');
`,
        'utf8',
      );
      const result = spawnSync(process.execPath, [probe], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, NODE_PATH: '' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        'filtered-lite-tokenizer: offline roundtrip passed',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not widen installer or ASAR budgets to hide the regression', () => {
    expect(resolveWindowsInstallerBudget({}).maxBytes).toBe(136_421_279);
    expect(resolveMacInstallerBudget({}).maxBytes).toBe(167_772_160);
  });
});
