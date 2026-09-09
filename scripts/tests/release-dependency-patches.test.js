/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
// An explicit isolated install lets a release audit avoid mutating shared
// node_modules. CI defaults to its own fresh installation.
const dependencyRoot = process.env.OTTO_DEPENDENCY_PATCH_ROOT || repoRoot;
const requireDependency = createRequire(
  path.join(dependencyRoot, 'package.json'),
);
const lock = JSON.parse(
  readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
);
const fastUri = requireDependency('fast-uri');
const qs = requireDependency('qs');

describe('release dependency security patches', () => {
  it.each([
    ['fast-uri', '3.1.6'],
    ['qs', '6.16.0'],
  ])(
    'locks %s at the reviewed fix and installs that exact version',
    (name, version) => {
      const entries = Object.entries(lock.packages).filter(
        ([key]) =>
          key.endsWith(`/node_modules/${name}`) ||
          key === `node_modules/${name}`,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0][1].version).toBe(version);
      expect(entries[0][1].resolved).toBe(
        `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      );
      expect(requireDependency(`${name}/package.json`).version).toBe(version);
    },
  );

  it('rejects malformed IPv6 instead of canonicalizing it to the unspecified address', () => {
    const input = 'http://[::not-valid]/private';
    expect(fastUri.parse(input).error).toBeTruthy();
    expect(fastUri.normalize(input)).toBe(input);
  });

  it('does not repeatedly decode a hostname into localhost', () => {
    const input = 'http://%256c%256f%2563%2561%256c%2568%256f%2573%2574/';
    expect(fastUri.parse(input).error).toBeTruthy();
    expect(fastUri.normalize(input)).toBe(input);
  });

  it('rejects an encoded scheme before it can turn into an authority', () => {
    const input = '%2f%2fevil.example:/pwn';
    expect(fastUri.parse(input).error).toBeTruthy();
    expect(fastUri.normalize(input)).toBe(input);
  });

  it('enforces the comma array limit inside bracket syntax', () => {
    expect(() =>
      qs.parse('a[]=1,2,3,4', {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      }),
    ).toThrow(RangeError);
  });

  it('does not invoke an attacker-controlled non-callable isBuffer property', () => {
    const value = qs.parse('a[constructor][isBuffer]=true&a[x]=1', {
      plainObjects: true,
    });
    expect(qs.stringify(value)).toBe(
      'a%5Bconstructor%5D%5BisBuffer%5D=true&a%5Bx%5D=1',
    );
  });

  it('keeps ordinary URI and query conversion working', () => {
    expect(fastUri.normalize('https://Example.COM:443/a')).toBe(
      'https://example.com/a',
    );
    expect(
      qs.parse('a[]=1,2,3', {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      }),
    ).toEqual({ a: [['1', '2', '3']] });
    expect(qs.stringify({ a: ['1', '2'] })).toBe('a%5B0%5D=1&a%5B1%5D=2');
  });
});
