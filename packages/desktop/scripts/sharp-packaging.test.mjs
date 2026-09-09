/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import asar from '@electron/asar';
import { describe, expect, it } from 'vitest';
import { desktopSharpTarget, sharpTargetFileSet, SHARP_UNPACK_PATTERNS, verifyPackagedSharp } from './sharp-packaging.mjs';

const require = createRequire(import.meta.url);
const { getFileMatchers } = require('app-builder-lib/out/fileMatcher.js');
const desktopRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));

it('matches only the per-target copied FileSet while the installed host-native packages stay excluded', () => {
  const staging = path.resolve(os.tmpdir(), 'otto-sharp-matcher-fixture');
  const destination = path.resolve(os.tmpdir(), 'otto-sharp-matcher-app');
  const [matcher] = getFileMatchers({ files: [sharpTargetFileSet(staging)] }, 'files', destination, {
    defaultSrc: desktopRoot, customBuildOptions: {}, globalOutDir: destination,
    macroExpander: value => value.replaceAll('${os}', 'mac').replaceAll('${arch}', 'x64'),
  });
  expect(matcher.from).toBe(path.join(staging, 'mac-x64/node_modules'));
  expect(matcher.to).toBe(path.join(destination, 'node_modules'));
  const filter = matcher.createFilter();
  const stat = { isDirectory: () => false };
  expect(filter(path.join(matcher.from, '@img/sharp-darwin-x64/lib/sharp.node'), stat)).toBe(true);
  expect(filter(path.join(matcher.from, '@img/sharp-libvips-darwin-x64/lib/include/glibconfig.h'), stat)).toBe(false);
  expect(filter(path.join(matcher.from, '@img/sharp-darwin-x64/README.md'), stat)).toBe(false);
  expect(packageJson.build.files).toContain('!**/node_modules/@img/sharp-*/**');
  expect(packageJson.build.asarUnpack).toEqual(SHARP_UNPACK_PATTERNS);
  expect(packageJson.build.beforePack).toBe('scripts/before-pack.cjs');
});

it.each([
  [{ electronPlatformName: 'darwin', arch: 1 }, 'darwin-x64'],
  [{ electronPlatformName: 'darwin', arch: 3 }, 'darwin-arm64'],
  [{ electronPlatformName: 'win32', arch: 'x64' }, 'win32-x64'],
])('maps builder architecture without using the build-host architecture: %j', (context, target) => {
  expect(desktopSharpTarget(context).target).toBe(target);
});
it('rejects unreviewed targets', () => expect(() => desktopSharpTarget({ electronPlatformName: 'win32', arch: 3 })).toThrow());

async function packagedFixture(variant, operation) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'otto-sharp-asar-contract-'));
  try {
    const sourceRoot = path.join(root, 'source');
    const appRoot = path.join(root, 'app');
    mkdirSync(sourceRoot);
    const integrity = 'sha512-' + createHash('sha512').update('fixture').digest('base64');
    writeFileSync(path.join(sourceRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      'packages/server': { dependencies: { sharp: '0.35.4' } },
      'node_modules/sharp': { version: '0.35.4', optionalDependencies: { '@img/sharp-win32-x64': '0.35.4' } },
      'node_modules/@img/sharp-win32-x64': { version: '0.35.4', os: ['win32'], cpu: ['x64'], integrity, resolved: 'https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-0.35.4.tgz' },
      'node_modules/heic-decode': { version: '2.1.0' }, 'node_modules/libheif-js': { version: '1.23.2' },
    } }));
    const files = {
      'node_modules/sharp/package.json': JSON.stringify({ name: 'sharp', version: '0.35.4' }),
      'node_modules/heic-decode/package.json': JSON.stringify({ name: 'heic-decode', version: variant === 'wrong-js' ? '1.0.0' : '2.1.0' }),
      'node_modules/libheif-js/package.json': JSON.stringify({ name: 'libheif-js', version: '1.23.2' }),
      'node_modules/@img/sharp-win32-x64/package.json': JSON.stringify({ name: '@img/sharp-win32-x64', version: variant === 'wrong-native' ? '0.0.1' : '0.35.4', os: ['win32'], cpu: ['x64'] }),
      'node_modules/@img/sharp-win32-x64/lib/sharp.node': 'native-test-bytes-not-executed',
      'node_modules/sharp/dist/index.cjs': '', 'node_modules/heic-decode/index.js': '', 'node_modules/heic-decode/lib.js': '',
      'node_modules/libheif-js/wasm-bundle.js': '', 'node_modules/libheif-js/libheif-wasm/libheif-bundle.js': '',
      'node_modules/otto-server/dist/src/modules/park_services/flea_market/fleaMarketImageProcessing.js': '',
    };
    if (variant === 'missing-wasm') delete files['node_modules/libheif-js/libheif-wasm/libheif-bundle.js'];
    if (variant === 'wrong-platform') files['node_modules/@img/sharp-linux-x64/package.json'] = '{}';
    if (variant === 'missing-native') delete files['node_modules/@img/sharp-win32-x64/lib/sharp.node'];
    for (const [relative, value] of Object.entries(files)) {
      const target = path.join(appRoot, relative);
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, value);
    }
    const archive = path.join(root, 'app.asar');
    await asar.createPackageWithOptions(appRoot, archive, { unpack: variant === 'packed-native' ? '**/node_modules/sharp/**/*' : '**/node_modules/{sharp,@img/sharp-*}/**/*' });
    await operation(archive, sourceRoot);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('real ASAR structural boundary (native execution is a separate smoke)', () => {
  it('accepts only matching unpacked native and complete JS/WASM runtime files', () => packagedFixture('valid', (archive, sourceRoot) => {
    expect(verifyPackagedSharp(archive, { target: 'win32-x64', sourceRoot })).toMatchObject({ applicable: true, packages: ['@img/sharp-win32-x64'] });
  }));
  it.each(['wrong-native', 'wrong-js', 'missing-wasm', 'wrong-platform', 'missing-native', 'packed-native'])('rejects %s', variant => packagedFixture(variant, (archive, sourceRoot) => {
    expect(() => verifyPackagedSharp(archive, { target: 'win32-x64', sourceRoot })).toThrow();
  }));
});
