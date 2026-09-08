/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
 * Additive experiment file capture. No execution, installation or network.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';
import {
  hashEntries,
  verifyBaseline,
  environmentInventory,
} from './agent-eval-baseline.mjs';

export const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const declarations = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];
const without = (value, keys) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );

export function safeRelative(file) {
  if (
    typeof file !== 'string' ||
    !file ||
    /[\\:\0]/u.test(file) ||
    file.split('/').some((s) => !s || s === '.' || s === '..')
  )
    throw new Error('Unsafe experiment path');
  return file;
}
export function assertNoLinks(absolute) {
  for (let p = path.resolve(absolute); ; p = path.dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error('Experiment path link refused');
    if (path.dirname(p) === p) break;
  }
}
export function newDirectory(destination, excluded = []) {
  if (!path.isAbsolute(destination))
    throw new Error('Absolute experiment directory required');
  assertNoLinks(destination);
  if (existsSync(destination))
    throw new Error('Experiment directory already exists; never overwrite');
  for (const root of excluded) {
    const rel = path.relative(realpathSync(root), path.resolve(destination));
    if (
      !rel ||
      (rel !== '..' &&
        !rel.startsWith('..' + path.sep) &&
        !path.isAbsolute(rel))
    )
      throw new Error('Experiment must be outside source inputs');
  }
  mkdirSync(destination);
}
export function seal(directory, name, value) {
  const content = json(value);
  writeFileSync(path.join(directory, name + '.json'), content, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(path.join(directory, name + '.sha256'), sha(content) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return sha(content);
}
export function readSealed(directory, name) {
  assertNoLinks(path.join(directory, name + '.json'));
  assertNoLinks(path.join(directory, name + '.sha256'));
  const content = readFileSync(path.join(directory, name + '.json'));
  if (
    sha(content) !==
    readFileSync(path.join(directory, name + '.sha256'), 'utf8').trim()
  )
    throw new Error('Experiment manifest changed');
  return JSON.parse(content);
}
const hashBuffer = Buffer.allocUnsafe(1024 * 1024);
export function fileDigest(file) {
  const fd = openSync(file, 'r');
  const buffer = hashBuffer;
  const digest = createHash('sha256');
  try {
    let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)))
      digest.update(buffer.subarray(0, length));
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** Allows only dependency declarations and npm's dev ownership flag to differ.
 * Version/resolution/integrity changes are a separate experiment, never normalized here.
 */
export function analyzeDependencyDelta(beforeLock, afterLock) {
  const changes = [];
  if (
    !beforeLock.packages ||
    !afterLock.packages ||
    beforeLock.lockfileVersion !== 3 ||
    !isDeepStrictEqual(
      without(beforeLock, ['packages']),
      without(afterLock, ['packages']),
    )
  )
    return {
      compatible: false,
      changes,
      reason: 'lock_schema_or_root_changed',
    };
  for (const name of [
    ...new Set([
      ...Object.keys(beforeLock.packages),
      ...Object.keys(afterLock.packages),
    ]),
  ].sort()) {
    const before = beforeLock.packages[name],
      after = afterLock.packages[name];
    if (isDeepStrictEqual(before, after)) continue;
    const installed = name.includes('node_modules/');
    const allowed = installed ? ['dev'] : declarations;
    const compatible =
      !!before &&
      !!after &&
      isDeepStrictEqual(without(before, allowed), without(after, allowed));
    changes.push({
      path: name,
      fields: [
        ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
      ].filter((key) => !isDeepStrictEqual(before?.[key], after?.[key])),
      compatible,
    });
  }
  return {
    compatible: changes.every((c) => c.compatible),
    changes,
    reason: 'dependency_ownership_only',
  };
}

function captureFile(source, destination, relative, parentsChecked = false) {
  safeRelative(relative);
  if (!parentsChecked) assertNoLinks(source);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > 512 * 1024 * 1024)
    throw new Error('Unsupported dependency file');
  const digest = fileDigest(source);
  const target = path.join(destination, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  if (fileDigest(target) !== digest)
    throw new Error('Input changed during experiment capture');
  return { path: relative, bytes: stat.size, sha256: digest };
}
export function verifyFiles(directory, files) {
  assertNoLinks(directory);
  const expected = new Map(
    files.map((entry) => [safeRelative(entry.path), entry]),
  );
  if (expected.size !== files.length)
    throw new Error('Duplicate captured path');
  let valid = true;
  function walk(relative = '') {
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) {
        valid = false;
        continue;
      }
      if (entry.isDirectory()) {
        walk(name);
        continue;
      }
      const spec = expected.get(name);
      const file = path.join(directory, name);
      if (
        !entry.isFile() ||
        !spec ||
        lstatSync(file).nlink > 1 ||
        lstatSync(file).size !== spec.bytes ||
        fileDigest(file) !== spec.sha256
      )
        valid = false;
      expected.delete(name);
    }
  }
  walk();
  return valid && expected.size === 0;
}

/** Private physical dependency copy, not junctions back to a mutable worktree. */
export function captureDependencies(
  dependencies,
  referenceSnapshot,
  destination,
) {
  assertNoLinks(dependencies);
  const reference = readSealed(referenceSnapshot, 'manifest');
  if (!verifyBaseline(referenceSnapshot).valid)
    throw new Error('Reference source changed');
  const before = environmentInventory(dependencies);
  for (const key of [
    'node',
    'nodeExecutableSha256',
    'platform',
    'arch',
    'osRelease',
    'timeZone',
    'cpuModel',
    'logicalCpus',
    'ramBytes',
    'lockSha256',
    'installed',
    'missing',
  ]) {
    if (!isDeepStrictEqual(before[key], reference.environment[key]))
      throw new Error(`Installed dependency condition changed: ${key}`);
  }
  newDirectory(destination, [dependencies, referenceSnapshot]);
  const payload = path.join(destination, 'payload');
  mkdirSync(payload);
  const source = path.join(referenceSnapshot, 'source');
  const pkg = JSON.parse(readFileSync(path.join(source, 'package.json')));
  const workspaces = pkg.workspaces ?? [];
  if (!Array.isArray(workspaces))
    throw new Error('Explicit workspace paths required');
  for (const workspace of workspaces) safeRelative(workspace);
  const lock = JSON.parse(readFileSync(path.join(source, 'package-lock.json')));
  const files = [];
  const excludedLinks = [];
  let bytes = 0;
  const capture = (file, relative, parentsChecked = false) => {
    files.push(captureFile(file, payload, relative, parentsChecked));
    bytes += files.at(-1).bytes;
    if (files.length > 250000 || bytes > 12 * 1024 ** 3)
      throw new Error('Dependency capture budget exceeded');
  };
  for (const file of [
    'package.json',
    'package-lock.json',
    ...workspaces.map((w) => w + '/package.json'),
  ])
    capture(path.join(source, file), file);
  const walk = (relative) => {
    const absolute = path.join(dependencies, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const item = lock.packages[relative];
      if (
        !item?.link ||
        !workspaces.includes(item.resolved) ||
        realpathSync(absolute) !==
          realpathSync(path.join(dependencies, item.resolved))
      )
        throw new Error('Unexpected dependency link; capture refused');
      excludedLinks.push({
        path: relative,
        workspace: item.resolved,
        reason: 'Use frozen variant TS aliases, never live worktree links',
      });
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort())
        walk(relative + '/' + entry);
    } else capture(absolute, relative, true);
  };
  for (const relative of [
    'node_modules',
    ...workspaces.map((w) => w + '/node_modules'),
  ])
    if (existsSync(path.join(dependencies, relative))) {
      assertNoLinks(path.join(dependencies, relative));
      walk(relative);
    }
  capture(
    process.execPath,
    'runtime/node' + (process.platform === 'win32' ? '.exe' : ''),
  );
  if (!isDeepStrictEqual(environmentInventory(dependencies), before))
    throw new Error('Dependency metadata changed during capture');
  if (!verifyFiles(payload, files))
    throw new Error('Dependency byte capture failed');
  const result = {
    schemaVersion: 1,
    kind: 'private-dependency-byte-capture',
    environment: before,
    files,
    fingerprint: hashEntries(files),
    bytes,
    excludedLinks,
    limitations: [
      'No installation or native rebuild. Existing missing/optional dependencies remain missing.',
      'Private Node/package bytes are pinned; Windows/OS services are not virtualized.',
      'Workspace links are excluded; the runner must bind variant source explicitly.',
    ],
  };
  seal(destination, 'manifest', result);
  return result;
}

export function deriveDependencyBaseline(original, reference, destination) {
  if (!verifyBaseline(original).valid || !verifyBaseline(reference).valid)
    throw new Error('Frozen source changed');
  const prior = readSealed(original, 'manifest');
  const donor = readSealed(reference, 'manifest');
  const oldSource = path.join(original, 'source'),
    newSource = path.join(reference, 'source');
  const oldLock = JSON.parse(
    readFileSync(path.join(oldSource, 'package-lock.json')),
  );
  const newLock = JSON.parse(
    readFileSync(path.join(newSource, 'package-lock.json')),
  );
  const delta = analyzeDependencyDelta(oldLock, newLock);
  if (!delta.compatible)
    throw new Error('Dependency versions/resolution changed; cannot normalize');
  const overlays = new Map([
    ['package-lock.json', path.join(newSource, 'package-lock.json')],
  ]);
  for (const change of delta.changes.filter(
    (c) => !c.path.includes('node_modules/'),
  )) {
    const relative = change.path
      ? change.path + '/package.json'
      : 'package.json';
    safeRelative(relative);
    const from = JSON.parse(readFileSync(path.join(oldSource, relative)));
    const to = JSON.parse(readFileSync(path.join(newSource, relative)));
    if (
      !isDeepStrictEqual(without(from, declarations), without(to, declarations))
    )
      throw new Error(
        'Non-dependency manifest change; refuse business/source overlay',
      );
    overlays.set(relative, path.join(newSource, relative));
  }
  newDirectory(destination, [original, reference]);
  const source = path.join(destination, 'source');
  mkdirSync(source);
  const files = [],
    transformations = [];
  const donorEntries = new Map(donor.source.files.map((f) => [f.path, f]));
  for (const entry of prior.source.files) {
    const file = overlays.get(entry.path) ?? path.join(oldSource, entry.path);
    const captured = captureFile(file, source, entry.path);
    if (
      captured.sha256 !==
      (overlays.has(entry.path)
        ? donorEntries.get(entry.path)?.sha256
        : entry.sha256)
    )
      throw new Error('Frozen input changed during derivation');
    files.push({ ...captured, state: entry.state });
    if (captured.sha256 !== entry.sha256)
      transformations.push({
        path: entry.path,
        beforeSha256: entry.sha256,
        afterSha256: captured.sha256,
        reason: 'Explicit common dependency declarations only',
      });
  }
  const manifest = {
    ...prior,
    createdAt: new Date().toISOString(),
    source: {
      ...prior.source,
      files,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      fingerprint: hashEntries(files),
    },
    identities: { ...prior.identities, runtimeFingerprint: null },
    environment: donor.environment,
    derivation: {
      originalSourceFingerprint: prior.source.fingerprint,
      originalManifestSha256: sha(
        readFileSync(path.join(original, 'manifest.json')),
      ),
      dependencyReferenceFingerprint: donor.source.fingerprint,
      transformations,
      lockDelta: delta,
      originalEnvironment: prior.environment,
      reason: 'Derived experiment only; original snapshot unchanged',
    },
  };
  seal(destination, 'manifest', manifest);
  if (
    !verifyBaseline(destination).valid ||
    !verifyBaseline(original).valid ||
    !verifyBaseline(reference).valid
  )
    throw new Error('Derived or original snapshot integrity failed');
  return manifest;
}
