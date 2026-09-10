/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCleanSource,
  assertHeicLock,
  assertSharpLock,
  buildCorrespondingSource,
  downloadSource,
  HEIC_SOURCE_INPUTS,
  SHARP_RUNTIME_INPUTS,
  gitArchivePaths,
  readVerifiedCache,
  readBundledLicense,
  sourceAssetName,
  verifyDownload,
  writeGitSourceArchive,
} from '../heic-corresponding-source.mjs';

const roots = [];
const temp = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'otto-heic-source-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const git = (root, ...args) =>
  execFileSync('git', ['-c', `safe.directory=${root}`, ...args], { cwd: root });
const lock = () => ({
  lockfileVersion: 3,
  packages: {
    'packages/server': { dependencies: { 'heic-decode': '2.1.0', sharp: '0.35.4' } },
    'node_modules/sharp': {
      version: '0.35.4',
      resolved: 'https://registry.npmjs.org/sharp/-/sharp-0.35.4.tgz',
      integrity: 'sha512-n++8XWcj+jCOr2IOl7h8LbKnGBDY4aPbmprMONBNFdn0ImXqpGVv5zliDs0V9HbmbCQLpbuo2ej9rAoOQTvMDA==',
    },
    ...Object.fromEntries(Object.entries(SHARP_RUNTIME_INPUTS).map(([name, entry]) => [`node_modules/${name}`, { ...entry }])),
    'node_modules/heic-decode': {
      version: '2.1.0',
      resolved:
        'https://registry.npmjs.org/heic-decode/-/heic-decode-2.1.0.tgz',
      integrity:
        'sha512-0fB3O3WMk38+PScbHLVp66jcNhsZ/ErtQ6u2lMYu/YxXgbBtl+oKOhGQHa4RpvE68k8IzbWkABzHnyAIjR758A==',
    },
    'node_modules/libheif-js': {
      version: '1.23.2',
      resolved: 'https://registry.npmjs.org/libheif-js/-/libheif-js-1.23.2.tgz',
      integrity:
        'sha512-qvHIXtggEsw1lCNCWBYKloL2Z36DJBm0R9ThGiH2JnhKYdeZFLPFkP30Lw4yMskxxhx0bKg1gLrBHX1D2w2pSw==',
    },
  },
});
function repo() {
  const root = temp();
  git(root, 'init', '-q');
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ version: '1.9.15' }),
  );
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock()));
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Source test',
    '-c',
    'user.email=source-test@invalid.example',
    'commit',
    '-qm',
    'fixture',
  );
  return root;
}
describe('HEIC corresponding-source release inputs', () => {
  it('rejects native version, origin or integrity drift on all five shipped targets', () => {
    expect(assertSharpLock(lock())).toHaveLength(6);
    for (const name of ['sharp', ...Object.keys(SHARP_RUNTIME_INPUTS)]) {
      for (const property of ['version', 'resolved', 'integrity']) {
        const changed = lock();
        changed.packages[`node_modules/${name}`][property] = 'substituted';
        expect(() => assertSharpLock(changed), `${name}:${property}`).toThrow(/locked/);
      }
      const missing = lock();
      delete missing.packages[`node_modules/${name}`];
      expect(() => assertSharpLock(missing)).toThrow(/locked/);
    }
    const ranged = lock();
    ranged.packages['packages/server'].dependencies.sharp = '^0.35.4';
    expect(() => assertSharpLock(ranged)).toThrow(/reviewed/);
  });
  it('also retains the reviewed sharp/libvips sources, build recipes, relinking inputs and elected MPL license', () => {
    for (const file of [
      'sharp-0.35.4.tgz', 'sharp-0.35.4-source.tar.gz',
      'sharp-libvips-1.3.3-build-source.tar.gz', 'sharp-libvips-1.3.3-posix.sh',
      'build-win64-mxe-8.18.6-source.tar.gz', 'libvips-8.18.6-source-release.tar.xz',
      'glib-2.89.4-source.tar.xz', 'pango-1.58.2-source.tar.xz',
      'librsvg-2.62.91-source.tar.xz', 'fribidi-1.0.16-source.tar.xz',
      'libexif-0.6.26-source.tar.xz', 'proxy-libintl-0.5-source.tar.gz',
      'cairo-1.18.4-source.tar.xz', 'glib-without-gregex.patch',
      'libvips-cpp-soversion.patch', 'sharp-libvips-dev-1.3.3.tgz',
      'sharp-libvips-win32-x64-1.3.3.tgz', 'vips-dev-x64-web-8.18.6-static.zip',
      'mxe-observed-d973945-source.tar.gz',
      'sharp-libvips-1.3.3-THIRD-PARTY-NOTICES.md', 'Mozilla-MPL-2.0.txt',
    ]) expect(HEIC_SOURCE_INPUTS.some(input => input.file === file), file).toBe(true);
    expect(new Set(HEIC_SOURCE_INPUTS.map(input => input.file)).size).toBe(HEIC_SOURCE_INPUTS.length);
    expect(HEIC_SOURCE_INPUTS.every(input => input.bytes <= 64 * 1024 * 1024)).toBe(true);
  });
  it('rejects arbitrary source URLs, unofficial redirects and oversized network bodies', async () => {
    const spec = HEIC_SOURCE_INPUTS.find(
      (source) => source.file === 'heic-decode-2.1.0-npm.tgz',
    );
    await expect(
      downloadSource({ ...spec, url: 'https://example.com/arbitrary' }),
    ).rejects.toThrow('unreviewed');
    await expect(
      downloadSource(
        spec,
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://example.com/not-official' },
          }),
      ),
    ).rejects.toThrow('outside official');
    await expect(
      downloadSource(
        spec,
        async () => new Response(Buffer.alloc(spec.bytes + 1)),
      ),
    ).rejects.toThrow('exceeded bound');
    await expect(
      downloadSource(spec, async () => new Response('wrong bytes')),
    ).rejects.toThrow('length mismatch');
  });

  it.each([403, 404, 503])('identifies a failed reviewed source and HTTP %i without exposing response data', async (status) => {
    const spec = HEIC_SOURCE_INPUTS.find(source => source.file === 'heic-decode-2.1.0-npm.tgz');
    const response = new Response('private upstream diagnostics must not be logged', { status });
    await expect(downloadSource(spec, async () => response)).rejects.toThrow(
      `official source download failed: ${spec.file} (registry.npmjs.org, HTTP ${status})`,
    );
    expect(response.body.locked).toBe(false);
    expect(response.bodyUsed).toBe(true);
  });

  it('uses only byte-verified license text from the exact committed source', () => {
    const root = repo();
    mkdirSync(path.join(root, 'scripts/licenses'), { recursive: true });
    for (const name of ['GNU-LGPL-3.0.txt', 'GNU-GPL-3.0.txt']) {
      const spec = HEIC_SOURCE_INPUTS.find(source => source.file === name);
      const original = Buffer.from(readFileSync(new URL(`../licenses/${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n'));
      expect(verifyDownload(original, spec)).toEqual(original);
      writeFileSync(path.join(root, 'scripts/licenses', name), original);
    }
    git(root, 'add', 'scripts/licenses');
    git(root, '-c', 'user.name=Source test', '-c', 'user.email=source-test@invalid.example', 'commit', '-qm', 'reviewed licenses');
    const commit = assertCleanSource(root).sourceCommit;
    for (const name of ['GNU-LGPL-3.0.txt', 'GNU-GPL-3.0.txt']) {
      const spec = HEIC_SOURCE_INPUTS.find(source => source.file === name);
      expect(readBundledLicense(root, commit, spec)).toHaveLength(spec.bytes);
      writeFileSync(path.join(root, 'scripts/licenses', name), 'uncommitted replacement');
      expect(readBundledLicense(root, commit, spec)).toHaveLength(spec.bytes);
      expect(() => assertCleanSource(root)).toThrow('clean HEAD');
      expect(() => readBundledLicense(root, commit, { ...spec, sha256: '0'.repeat(64) })).toThrow('unreviewed');
    }
    git(root, 'add', 'scripts/licenses');
    git(root, '-c', 'user.name=Source test', '-c', 'user.email=source-test@invalid.example', 'commit', '-qm', 'corrupted licenses');
    for (const name of ['GNU-LGPL-3.0.txt', 'GNU-GPL-3.0.txt']) {
      const spec = HEIC_SOURCE_INPUTS.find(source => source.file === name);
      expect(() => readBundledLicense(root, assertCleanSource(root).sourceCommit, spec)).toThrow('length mismatch');
    }
  }, 15000);

  it('does not replace non-license downloads and refuses missing tracked license bytes', () => {
    const root = repo();
    const commit = assertCleanSource(root).sourceCommit;
    const library = HEIC_SOURCE_INPUTS.find(source => source.file === 'heic-decode-2.1.0-npm.tgz');
    expect(readBundledLicense(root, commit, library)).toBeUndefined();
    const license = HEIC_SOURCE_INPUTS.find(source => source.file === 'GNU-LGPL-3.0.txt');
    expect(() => readBundledLicense(root, commit, license)).toThrow();
  });

  it('refuses in-checkout output before performing a build or download', async () => {
    const root = repo();
    await expect(
      buildCorrespondingSource({
        repoRoot: root,
        outputDir: path.join(root, 'output'),
      }),
    ).rejects.toThrow('outside');
  });

  it('names a separate versioned sidecar and rejects unsafe/non-release versions', () => {
    expect(sourceAssetName('1.9.15')).toBe(
      'otto-1.9.15-corresponding-source.tar.gz',
    );
    for (const version of [
      '../1.9.15',
      '1.9.15/evil',
      '1.9.15\n',
      '1.9.15-beta',
    ])
      expect(() => sourceAssetName(version)).toThrow();
  });
  it('accepts only the exact reviewed npm URL, version and integrity', () => {
    expect(assertHeicLock(lock())).toHaveLength(2);
    for (const property of ['version', 'resolved', 'integrity']) {
      const changed = lock();
      changed.packages['node_modules/libheif-js'][property] = 'substituted';
      expect(() => assertHeicLock(changed)).toThrow(/reviewed|locked/);
    }
    const ranged = lock();
    ranged.packages['packages/server'].dependencies['heic-decode'] = '^2.1.0';
    expect(() => assertHeicLock(ranged)).toThrow();
  });
  it('checks exact length and digest before trusting cache/downloaded bytes', () => {
    const spec = {
      file: 'source.tar.gz',
      bytes: 3,
      sha256:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    };
    expect(verifyDownload(Buffer.from('abc'), spec)).toEqual(
      Buffer.from('abc'),
    );
    for (const bytes of ['ab', 'abcd', 'abd'])
      expect(() => verifyDownload(Buffer.from(bytes), spec)).toThrow();
    const cache = temp();
    writeFileSync(path.join(cache, spec.file), 'abd');
    expect(() => readVerifiedCache(cache, spec)).toThrow(/hash|digest/);
    expect(() =>
      readVerifiedCache(cache, { ...spec, file: '../source.tar.gz' }),
    ).toThrow();
  });
  it('rejects unstaged, staged and untracked changes rather than labeling them clean HEAD', () => {
    const root = repo();
    expect(assertCleanSource(root).sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    writeFileSync(path.join(root, 'untracked.txt'), 'private working file');
    expect(() => assertCleanSource(root)).toThrow(/clean/);
    git(root, 'add', 'untracked.txt');
    expect(() => assertCleanSource(root)).toThrow(/clean/);
    git(
      root,
      '-c',
      'user.name=Source test',
      '-c',
      'user.email=source-test@invalid.example',
      'commit',
      '-qm',
      'tracked',
    );
    writeFileSync(path.join(root, 'package.json'), '{}');
    expect(() => assertCleanSource(root)).toThrow(/clean/);
  });
  it('archives all tracked HEAD files but no ignored credentials or working outputs', () => {
    const root = repo();
    writeFileSync(path.join(root, '.gitignore'), 'private.env\n');
    git(root, 'add', '.gitignore');
    git(
      root,
      '-c',
      'user.name=Source test',
      '-c',
      'user.email=source-test@invalid.example',
      'commit',
      '-qm',
      'ignore',
    );
    writeFileSync(path.join(root, 'private.env'), 'not for distribution');
    const output = path.join(temp(), 'otto-source.tar.gz');
    const receipt = writeGitSourceArchive(
      root,
      output,
      assertCleanSource(root).sourceCommit,
    );
    expect(receipt.fileCount).toBe(3);
    expect(
      execFileSync('tar', ['-tzf', output], { encoding: 'utf8' }),
    ).not.toContain('private.env');
    expect(readFileSync(output).length).toBeGreaterThan(0);
  });
  it('rejects export-ignore omissions instead of calling a partial archive full source', () => {
    const root = repo();
    mkdirSync(path.join(root, 'source'));
    writeFileSync(path.join(root, 'source/code.js'), 'source');
    writeFileSync(path.join(root, '.gitattributes'), 'source export-ignore\n');
    git(root, 'add', '.');
    git(
      root,
      '-c',
      'user.name=Source test',
      '-c',
      'user.email=source-test@invalid.example',
      'commit',
      '-qm',
      'export ignore',
    );
    expect(() =>
      writeGitSourceArchive(
        root,
        path.join(temp(), 'source.tar.gz'),
        assertCleanSource(root).sourceCommit,
      ),
    ).toThrow(/complete|omitted/);
  });

  it('preserves real UTF-8 Chinese names and long PAX paths without parsing bsdtar display escaping', () => {
    const root = repo();
    const names = [
      'docs/Otto-政策智能服务-PRD-v1.3-修订版.md',
      `docs/${'政策'.repeat(30)}/对应源码-${'构建'.repeat(15)}.md`,
    ];
    for (const name of names) {
      const target = path.join(root, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'real UTF-8 source');
    }
    git(root, 'add', '.');
    git(
      root,
      '-c',
      'user.name=Source test',
      '-c',
      'user.email=source-test@invalid.example',
      'commit',
      '-qm',
      'unicode and PAX source paths',
    );
    const archive = path.join(temp(), 'unicode-source.tar.gz');
    const receipt = writeGitSourceArchive(
      root,
      archive,
      assertCleanSource(root).sourceCommit,
    );
    expect(receipt.fileCount).toBe(4);
    expect(receipt.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(names),
    );
    const raw = gunzipSync(readFileSync(archive));
    const changed = Buffer.from(raw);
    changed[0] ^= 1;
    expect(() => gitArchivePaths(gzipSync(changed))).toThrow('checksum');
    expect(() => gitArchivePaths(gzipSync(raw.subarray(0, 513)))).toThrow(
      /truncated|incomplete/,
    );
  });
});
