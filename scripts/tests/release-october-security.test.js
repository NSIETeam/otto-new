/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSharpRuntimePackages } from '../sharp-runtime-assets.mjs';
import { assertSharpLock, HEIC_SOURCE_INPUTS, SHARP_RUNTIME_INPUTS } from '../heic-corresponding-source.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'package.json'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

describe('October release security inputs', () => {
  it.each([
    ['electron', '43.7.7'], ['simple-git', '4.0.2'],
    ['@grpc/grpc-js', '1.14.5'], ['fast-uri', '3.1.8'],
    ['hono', '4.13.13'], ['ip-address', '10.7.3'],
    ['http-cache-semantics', '4.3.0'], ['proxy-addr', '2.0.8'],
    ['source-map-js', '1.2.2'], ['postcss-selector-parser', '7.1.6'],
    ['global-agent', '4.1.3'], ['argparse', '2.0.1'],
    ['shell-quote', '1.11.0'], ['sharp', '0.35.5'],
  ])('pins every %s copy to the reviewed fix %s', (name, version) => {
    const entries = Object.entries(lock.packages).filter(([key]) =>
      key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
    expect(entries.length).toBeGreaterThan(0);
    for (const [, entry] of entries) expect(entry.version).toBe(version);
  });

  it('keeps the direct and overridden dependency declarations on the reviewed fixes', () => {
    const manifest = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    expect(manifest('package.json').overrides['shell-quote']).toBe('1.11.0');
    expect(manifest('packages/core/package.json').dependencies['shell-quote']).toBe('1.11.0');
    expect(manifest('packages/server/package.json').dependencies.sharp).toBe('0.35.5');
  });

  it('admits the fixed Linux sharp closure and rejects the formerly reviewed affected version', () => {
    const packages = resolveSharpRuntimePackages(lock);
    expect(packages.map(({ version }) => version).sort()).toEqual([
      '0.35.5', '0.35.5', '1.3.4', '1.3.4',
    ]);
    const affected = structuredClone(lock);
    affected.packages['node_modules/sharp'].version = '0.35.4';
    affected.packages['packages/server'].dependencies.sharp = '0.35.4';
    expect(() => resolveSharpRuntimePackages(affected)).toThrow(/unreviewed sharp version/);
  });

  it('binds corresponding-source inputs to the patched runtime on every shipped target', () => {
    expect(assertSharpLock(lock)).toHaveLength(6);
  });

  it('retains the upgraded copyleft sources and memory-limit patch without replacing the distinct HEIC WASM source', () => {
    const files = HEIC_SOURCE_INPUTS.map(({ file }) => file);
    for (const file of ['glib-2.90.0-source.tar.xz', 'fribidi-1.0.17-source.tar.xz',
      'cairo-1.18.6-source.tar.xz', 'libheif-native-1.23.5-source.tar.gz',
      'libheif-1.23.2-source.tar.gz', 'librsvg-2.63.2-source.tar.xz',
      'librsvg-embedded-memory-limit-9106011.patch', 'Cairo-1.18.6-MPL-1.1.txt']) {
      expect(files, file).toContain(file);
    }
    for (const entry of Object.values(SHARP_RUNTIME_INPUTS)) {
      expect(entry.versions).toMatchObject({ glib: '2.90.0', fribidi: '1.0.17',
        cairo: '1.18.6', heif: '1.23.5', rsvg: '2.63.2', vips: '8.18.7' });
    }
  });

  it('identifies the actual native release and upstream elected Cairo license in the shipped notice', () => {
    const notice = readFileSync(path.join(root, 'packages/server/NOTICE'), 'utf8');
    expect(notice).toContain('sharp 0.35.5 / libvips 8.18.7');
    expect(notice).toContain('MPL-1.1 for cairo');
    expect(notice).toContain('----- BEGIN SHARP CAIRO-MPL-1.1 -----');
    expect(notice).toContain('sharp-libvips-corresponding-source-audit-20261006.md');
  });

  it.each(['\n', '\r', '\u2028', '\u2029'])(
    'rejects a line terminator %j after a shell comment instead of quoting an unsafe command',
    (separator) => {
      const { quote } = require('shell-quote');
      // Inspect quoting only. Never execute the resulting shell text.
      expect(() => quote(['echo', 'ok', { comment: 'note' }, `value${separator}unexpected`]))
        .toThrow(TypeError);
    },
  );

  it('preserves safe shell quoting and the parse API used by Otto tools', () => {
    const { quote, parse } = require('shell-quote');
    const tokens = ['tool', 'a b', "quote'example", '中文路径'];
    expect(parse(quote(tokens))).toEqual(tokens);
    expect(parse('tool --output "a b.docx"')).toEqual(['tool', '--output', 'a b.docx']);
    expect(() => quote(['echo', 'ok', { comment: 'note' }, 'safe'])).not.toThrow();
  });

  it('removes sprintf-js through compatible consumers, not an audit suppression', () => {
    expect(Object.keys(lock.packages).some((key) => key.endsWith('/sprintf-js'))).toBe(false);
  });

  it('removes the vulnerable braces tree rather than disguising a fork or accepting its advisory', () => {
    for (const name of ['braces', 'micromatch']) {
      expect(Object.keys(lock.packages).some((key) =>
        key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))).toBe(false);
    }
    const source = readFileSync(path.join(root, 'packages/core/src/tools/grep.ts'), 'utf8');
    expect(source).toContain("import picomatch from 'picomatch'");
  });

  it('preserves argparse camel-case APIs used by Mammoth and YAML CLIs', () => {
    const { ArgumentParser } = require('argparse');
    const parser = new ArgumentParser({ addHelp: false });
    parser.addArgument(['input']);
    parser.addArgument(['--output-dir'], { dest: 'outputDir' });
    expect(parser.parseArgs(['input.docx', '--output-dir', 'out'])).toMatchObject({
      input: 'input.docx', outputDir: 'out',
    });
  });
});
