/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const root = repoRoot;
const requireFromRoot = requireDependency;
const { MockerRegistry } = await import(pathToFileURL(requireFromRoot.resolve('@vitest/mocker')).href);
const { interceptorPlugin } = await import(pathToFileURL(requireFromRoot.resolve('@vitest/mocker/node')).href);
const { getQueryParam, getQueryParams } = await import(pathToFileURL(requireFromRoot.resolve('hono/utils/url')).href);
const requireFromMatter = createRequire(requireFromRoot.resolve('gray-matter'));
const yaml3 = requireFromMatter('js-yaml');
const yaml4 = requireFromRoot('js-yaml');
const matter = requireFromRoot('gray-matter');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

describe('release dependency security patches (September 2026)', () => {
  // Exact versions are reviewed release inputs, not permission to accept arbitrary
  // newer releases. This test does not install packages or consult the network.
  it.each([
    ['hono', '4.13.5'],
    ['js-yaml', '4.3.2'],
    ['gray-matter/node_modules/js-yaml', '3.15.2'],
    ['vitest', '4.1.11'],
    ['@vitest/mocker', '4.1.11'],
    ['@vitest/coverage-v8', '4.1.11'],
  ])('pins reviewed %s in both the lock and installed runtime', (name, version) => {
    const entry = `node_modules/${name}`;
    const lock = readJson(path.join(root, 'package-lock.json'));
    expect(lock.packages[entry]?.version).toBe(version);
    expect(lock.packages[entry]?.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
    expect(lock.packages[entry]?.integrity).toMatch(/^sha512-/u);
    expect(readJson(path.join(dependencyRoot, entry, 'package.json')).version).toBe(version);
  });

  describe.each([
    ['gray-matter js-yaml 3', (source, options) => yaml3.safeLoad(source, options)],
    ['build-tool js-yaml 4', (source, options) => yaml4.load(source, options)],
  ])('%s empty-merge budget (GHSA-2883-xcg3-v3hh)', (_name, load) => {
    it('preserves ordinary YAML and a single empty merge within the budget', () => {
      const value = load('empty: &empty {}\nitem:\n  <<: *empty\n  name: Otto\n', { maxTotalMergeKeys: 1 });
      expect(value.item).toEqual({ name: 'Otto' });
    });

    it('counts empty merge sources and rejects exceeding a tiny budget', () => {
      // Three empty maps only: exercise the missing budget accounting without
      // constructing the large quadratic-time denial-of-service payload.
      const source = 'empty: &empty {}\nitem:\n  <<: [*empty, *empty, *empty]\n';
      expect(Buffer.byteLength(source)).toBeLessThan(128);
      expect(() => load(source, { maxTotalMergeKeys: 1 })).toThrow(/maxTotalMergeKeys/u);
    });
  });

  it('preserves the real gray-matter frontmatter entry point', () => {
    const parsed = matter('---\nname: otto-test\ndescription: Safe skill frontmatter\n---\n# Body\n');
    expect(parsed.data).toEqual({ name: 'otto-test', description: 'Safe skill frontmatter' });
    expect(parsed.content).toContain('# Body');
    expect(readJson(requireFromMatter.resolve('js-yaml/package.json')).version).toBe('3.15.2');
  });

  describe('Hono query fragment isolation (GHSA-crvj-82cr-hjcx)', () => {
    it('keeps legitimate query values and repeated parameters', () => {
      const url = 'https://fixture.invalid/item?role=viewer&tag=one&tag=two';
      expect(getQueryParam(url, 'role')).toBe('viewer');
      expect(getQueryParams(url, 'tag')).toEqual(['one', 'two']);
    });

    it('does not treat a question mark inside a fragment as a query', () => {
      const url = 'https://fixture.invalid/item#note?role=admin&tag=hidden';
      expect(getQueryParam(url, 'role')).toBeUndefined();
      expect(getQueryParams(url, 'tag')).toBeUndefined();
      expect(getQueryParam(url)).toEqual({});
    });

    it('stops an existing query at the fragment and retains encoded hash data', () => {
      const url = 'https://fixture.invalid/item?role=viewer&tag=a%23b#note&role=admin&hidden=yes';
      expect(getQueryParam(url, 'role')).toBe('viewer');
      expect(getQueryParams(url, 'role')).toEqual(['viewer']);
      expect(getQueryParam(url, 'tag')).toBe('a#b');
      expect(getQueryParam(url, 'hidden')).toBeUndefined();
    });
  });

  describe('Vitest redirect boundaries (GHSA-82fw-gwwq-j7x9)', () => {
    function registrationHarness(options = {}) {
      const fixtureRoot = path.resolve(root, 'unused-fixture-root').replaceAll('\\', '/');
      const handlers = new Map();
      const acknowledgements = [];
      const registry = new MockerRegistry();
      const plugin = interceptorPlugin({ registry, ...options });
      // The actual installed plugin and Vite allowlist implementation execute.
      // Only the event transport is in-memory: no listener, files, or secret data.
      plugin.configureServer({
        config: {
          root: fixtureRoot,
          server: { fs: { strict: true, allow: [fixtureRoot], deny: ['**/.env'] } },
          fsDenyGlob: (filename) => filename.endsWith('/.env'),
          safeModulePaths: new Set(),
        },
        ws: {
          on: (event, handler) => handlers.set(event, handler),
          send: (event) => acknowledgements.push(event),
        },
      });
      return {
        registry, handlers, acknowledgements, fixtureRoot,
        register(redirect) {
          const handler = handlers.get('vitest:interceptor:register');
          expect(handler).toBeTypeOf('function');
          handler({ type: 'redirect', raw: '/fixture', id: '/fixture', url: '/fixture', redirect });
        },
      };
    }

    it('accepts a redirect within the declared allowlist', () => {
      const harness = registrationHarness();
      harness.register('otto-fixture:allowed.js');
      expect(harness.registry.getById('/fixture')?.redirect).toBe(`${harness.fixtureRoot}/allowed.js`);
      expect(harness.acknowledgements).toContain('vitest:interceptor:register:result');
    });

    it.each(['otto-fixture:../outside.txt', 'otto-fixture:.env'])(
      'rejects traversal or denied files before registering a redirect: %s',
      (redirect) => {
        const harness = registrationHarness();
        harness.register(redirect);
        expect(harness.registry.getById('/fixture')).toBeUndefined();
        expect(harness.acknowledgements).toContain('vitest:interceptor:register:result');
      },
    );

    it('can disable unauthenticated redirect registration for authenticated callers', () => {
      const harness = registrationHarness({ registerWebSocketEvents: false });
      expect([...harness.handlers.keys()]).toEqual([]);
    });

    it('ships the reviewed allowlist guard in the installed mocker implementation', () => {
      const source = readFileSync(requireFromRoot.resolve('@vitest/mocker/node'), 'utf8');
      expect(source.includes('isFileLoadingAllowed')).toBe(true);
      expect(/registerWebSocketEvents\s*===\s*false/u.test(source)).toBe(true);
    });
  });
});
