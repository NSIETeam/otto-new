/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  analyzeDependencyDelta,
  deriveDependencyBaseline,
  verifyFiles,
  newDirectory,
  seal,
  sha,
  fileDigest,
} from '../agent-experiment-files.mjs';
import { hashEntries, verifyBaseline } from '../agent-eval-baseline.mjs';
const temporary = [];
// Use a canonical fixture base without relaxing the product's link checks.
const temporaryRoot = realpathSync(tmpdir());
const parent = () => {
  const dir = mkdtempSync(path.join(temporaryRoot, 'otto-experiment-unit-'));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    if (
      !path.isAbsolute(dir) ||
      path.dirname(dir) !== temporaryRoot ||
      !path.basename(dir).startsWith('otto-experiment-unit-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
const lock = (extra = false) => ({
  name: 'fixture',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture' },
    'packages/server': { dependencies: extra ? { prettier: '3.9.6' } : {} },
    'node_modules/prettier': {
      version: '3.9.6',
      integrity: 'fixture',
      ...(extra ? {} : { dev: true }),
    },
  },
});
function snapshot(directory, extra, runtime) {
  mkdirSync(path.join(directory, 'source/packages/server'), {
    recursive: true,
  });
  const entries = Object.entries({
    'package.json': { name: 'fixture', workspaces: ['packages/server'] },
    'packages/server/package.json': {
      name: 'server',
      scripts: { test: 'safe' },
      dependencies: extra ? { prettier: '3.9.6' } : {},
    },
    'package-lock.json': lock(extra),
    'packages/server/runtime.ts': runtime,
  }).map(([file, content]) => {
    const bytes =
      typeof content === 'string' ? content : JSON.stringify(content);
    writeFileSync(path.join(directory, 'source', file), bytes);
    return {
      path: file,
      bytes: Buffer.byteLength(bytes),
      sha256: sha(bytes),
      state: 'untracked',
    };
  });
  const manifest = {
    schemaVersion: 1,
    kind: 'offline-source-baseline',
    source: {
      files: entries,
      fingerprint: hashEntries(entries),
      bytes: entries.reduce((n, f) => n + f.bytes, 0),
    },
    environment: { lockSha256: sha(JSON.stringify(lock(extra))) },
    identities: {},
  };
  seal(directory, 'manifest', manifest);
  return manifest;
}
it('describes the actual ownership-only lock delta without suppressing it', () => {
  const delta = analyzeDependencyDelta(lock(), lock(true));
  expect(delta.compatible).toBe(true);
  expect(delta.changes.map((c) => c.path)).toEqual([
    'node_modules/prettier',
    'packages/server',
  ]);
});
it.each(['version', 'integrity', 'resolved'])(
  'refuses to normalize installed %s changes',
  (field) => {
    const changed = lock(true);
    changed.packages['node_modules/prettier'][field] = 'different';
    expect(analyzeDependencyDelta(lock(), changed).compatible).toBe(false);
  },
);
it('refuses new dependency packages or lock schemas', () => {
  const changed = lock(true);
  changed.packages['node_modules/new'] = { version: '1' };
  expect(analyzeDependencyDelta(lock(), changed).compatible).toBe(false);
  expect(
    analyzeDependencyDelta({ ...lock(), lockfileVersion: 2 }, lock(true))
      .compatible,
  ).toBe(false);
});
it('creates traceable separate variants and changes only dependency files in the old copy', () => {
  const dir = parent(),
    old = path.join(dir, 'old'),
    next = path.join(dir, 'next');
  expect(realpathSync(dir)).toBe(dir);
  const a = snapshot(old, false, 'old dirty code'),
    b = snapshot(next, true, 'new dirty code');
  const derived = path.join(dir, 'derived');
  const result = deriveDependencyBaseline(old, next, derived);
  expect(result.derivation.originalSourceFingerprint).toBe(
    a.source.fingerprint,
  );
  expect(result.derivation.dependencyReferenceFingerprint).toBe(
    b.source.fingerprint,
  );
  expect(result.derivation.transformations.map((f) => f.path).sort()).toEqual([
    'package-lock.json',
    'packages/server/package.json',
  ]);
  expect(
    readFileSync(
      path.join(derived, 'source/packages/server/runtime.ts'),
      'utf8',
    ),
  ).toBe('old dirty code');
  expect(verifyBaseline(old).fingerprint).toBe(a.source.fingerprint);
  expect(verifyBaseline(next).fingerprint).toBe(b.source.fingerprint);
  expect(verifyBaseline(derived).valid).toBe(true);
  expect(() => deriveDependencyBaseline(old, next, derived)).toThrow(/exist/);
});
it('fails before derivation if a donor includes unrelated script changes', () => {
  const dir = parent(),
    old = path.join(dir, 'old'),
    next = path.join(dir, 'next');
  snapshot(old, false, 'old');
  snapshot(next, true, 'next');
  // Recreate a self-consistent but semantically unsuitable donor snapshot.
  const bad = path.join(dir, 'bad');
  snapshot(bad, true, 'next');
  const manifestFile = path.join(bad, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile));
  const relative = 'packages/server/package.json';
  const content = JSON.stringify({
    name: 'server',
    scripts: { test: 'unsafe-change' },
    dependencies: { prettier: '3.9.6' },
  });
  writeFileSync(path.join(bad, 'source', relative), content);
  Object.assign(
    manifest.source.files.find((f) => f.path === relative),
    { bytes: Buffer.byteLength(content), sha256: sha(content) },
  );
  manifest.source.fingerprint = hashEntries(manifest.source.files);
  const bytes = JSON.stringify(manifest);
  writeFileSync(manifestFile, bytes);
  writeFileSync(path.join(bad, 'manifest.sha256'), sha(bytes));
  expect(() =>
    deriveDependencyBaseline(old, bad, path.join(dir, 'derived')),
  ).toThrow(/Non-dependency/);
  expect(existsSync(path.join(dir, 'derived'))).toBe(false);
});
it('detects same-length tampering and extra executable files in a captured tree', () => {
  const dir = parent();
  writeFileSync(path.join(dir, 'file.js'), 'aaaa');
  const entries = [
    {
      path: 'file.js',
      bytes: 4,
      sha256: fileDigest(path.join(dir, 'file.js')),
    },
  ];
  expect(verifyFiles(dir, entries)).toBe(true);
  writeFileSync(path.join(dir, 'file.js'), 'bbbb');
  expect(verifyFiles(dir, entries)).toBe(false);
  writeFileSync(path.join(dir, 'file.js'), 'aaaa');
  writeFileSync(path.join(dir, 'new.js'), 'new');
  expect(verifyFiles(dir, entries)).toBe(false);
});
it('refuses nested source outputs and destination junctions', () => {
  const dir = parent(),
    source = path.join(dir, 'source');
  mkdirSync(source);
  expect(() => newDirectory(path.join(source, 'out'), [source])).toThrow(
    /outside/,
  );
  expect(existsSync(path.join(source, 'out'))).toBe(false);
  const target = path.join(dir, 'target');
  mkdirSync(target);
  writeFileSync(path.join(target, 'sentinel'), 'user-owned');
  symlinkSync(target, path.join(dir, 'linked'), 'junction');
  expect(() => newDirectory(path.join(dir, 'linked/out'), [])).toThrow(/link/);
  expect(existsSync(path.join(target, 'out'))).toBe(false);
  expect(readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe(
    'user-owned',
  );
});
