/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
  ])('pins every %s copy to the reviewed fix %s', (name, version) => {
    const entries = Object.entries(lock.packages).filter(([key]) =>
      key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
    expect(entries.length).toBeGreaterThan(0);
    for (const [, entry] of entries) expect(entry.version).toBe(version);
  });

  it('removes sprintf-js through compatible consumers, not an audit suppression', () => {
    expect(Object.keys(lock.packages).some((key) => key.endsWith('/sprintf-js'))).toBe(false);
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
