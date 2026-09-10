/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const ENTERPRISE_SHARP_TARGETS = Object.freeze(['linux-x64', 'linux-arm64']);
const reviewedTargets = new Set([...ENTERPRISE_SHARP_TARGETS, 'darwin-x64', 'darwin-arm64', 'win32-x64']);
const maxArchiveBytes = 40 * 1024 * 1024;
const maxExpandedBytes = 160 * 1024 * 1024;
const sha = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

export function resolveSharpRuntimePackages(lock, targets = ENTERPRISE_SHARP_TARGETS) {
  requireThat(lock?.lockfileVersion === 3 && lock.packages, 'sharp requires lockfile v3');
  requireThat(Array.isArray(targets) && targets.length > 0 && new Set(targets).size === targets.length && targets.every(target => reviewedTargets.has(target)), 'unsupported or duplicate sharp target');
  if (!lock.packages['packages/server']?.dependencies?.sharp) return [];
  const sharp = lock.packages['node_modules/sharp'];
  requireThat(sharp?.version === '0.35.4' && lock.packages['packages/server'].dependencies.sharp === sharp.version, 'unreviewed sharp version');
  return targets.flatMap(target => {
    const [platform, arch] = target.split('-');
    return (platform === 'win32' ? ['sharp'] : ['sharp', 'sharp-libvips']).map(stem => {
      const name = `@img/${stem}-${target}`;
      const location = `node_modules/${name}`;
      const entry = lock.packages[location];
      const version = stem === 'sharp' ? sharp.version : '1.3.3';
      const url = `https://registry.npmjs.org/${name}/-/${stem}-${target}-${version}.tgz`;
      requireThat(entry?.version === version && sharp.optionalDependencies?.[name] === version, 'missing or mismatched required sharp target package');
      requireThat(entry.resolved === url && /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity), 'sharp target registry or integrity is not pinned');
      requireThat(JSON.stringify(entry.os) === JSON.stringify([platform]) && JSON.stringify(entry.cpu) === JSON.stringify([arch]), 'sharp target platform mismatch');
      return { name, version, target, platform, arch, location, resolved: url, integrity: entry.integrity };
    });
  });
}

function octal(header, offset, size) {
  const value = header.subarray(offset, offset + size).toString('ascii').replaceAll('\0', '').trim();
  requireThat(/^[0-7]+$/.test(value), 'invalid npm tar numeric field');
  const parsed = Number.parseInt(value, 8);
  requireThat(Number.isSafeInteger(parsed), 'oversized npm tar numeric field');
  return parsed;
}
function tarString(header, offset, size) {
  const bytes = header.subarray(offset, offset + size);
  const index = bytes.indexOf(0);
  return bytes.subarray(0, index === -1 ? bytes.length : index).toString('utf8');
}
function portablePath(name) {
  requireThat(name.startsWith('package/'), 'npm tar entry outside package root');
  const relative = name.slice(8).replace(/\/$/, '');
  requireThat(relative.length > 0 && relative.length <= 240 && !/[\\:]/.test(relative)
    && [...relative].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127), 'unsafe npm tar path');
  requireThat(relative.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !/[. ]$/.test(segment)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)), 'unsafe npm tar path segment');
  return relative;
}

export function verifiedPackageFiles(bytes, spec) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maxArchiveBytes, 'sharp archive size exceeded');
  requireThat(`sha512-${sha(bytes, 'sha512', 'base64')}` === spec.integrity, 'sharp archive integrity mismatch');
  const tar = gunzipSync(bytes, { maxOutputLength: maxExpandedBytes });
  const files = new Map();
  const seen = new Set();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      requireThat(tar.length - offset >= 1024 && tar.subarray(offset).every(byte => byte === 0), 'invalid npm tar terminator');
      ended = true;
      break;
    }
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    requireThat(octal(header, 148, 8) === sum, 'npm tar header checksum mismatch');
    const prefix = tarString(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${tarString(header, 0, 100)}`;
    const type = header[156];
    requireThat(type === 0 || type === 48 || type === 53, 'npm tar links or special entries are forbidden');
    const size = octal(header, 124, 12);
    requireThat(offset + 512 + Math.ceil(size / 512) * 512 <= tar.length && (type !== 53 || size === 0), 'truncated npm tar entry');
    // npm tarballs may explicitly include the package root directory.
    if (!(type === 53 && (name === 'package/' || name === 'package'))) {
      const relative = portablePath(name);
      requireThat(!seen.has(relative.toLowerCase()) && seen.size < 1024, 'duplicate or excessive npm tar entries');
      seen.add(relative.toLowerCase());
      if (type !== 53) files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  requireThat(ended && files.has('package.json'), 'npm tar package metadata or terminator missing');
  const pkg = JSON.parse(files.get('package.json').toString('utf8'));
  requireThat(pkg.name === spec.name && pkg.version === spec.version, 'sharp archive package identity mismatch');
  requireThat(JSON.stringify(pkg.os) === JSON.stringify([spec.platform]) && JSON.stringify(pkg.cpu) === JSON.stringify([spec.arch]), 'sharp archive target mismatch');
  requireThat(spec.platform !== 'linux' || JSON.stringify(pkg.libc) === JSON.stringify(['glibc']), 'sharp archive requires Linux glibc');
  return files;
}

function assertDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const stat = lstatSync(current);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'sharp asset directory is not an ordinary directory');
  }
}
function filesBelow(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const stat = lstatSync(absolute);
    requireThat(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'sharp material contains a link or special file');
    return stat.isDirectory() ? filesBelow(absolute, relative) : [relative];
  }).sort();
}

async function download(spec) {
  const response = await fetch(spec.resolved, { redirect: 'error', signal: AbortSignal.timeout(60_000), credentials: 'omit' });
  requireThat(response.ok && response.body, 'sharp registry download failed');
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      requireThat(length <= maxArchiveBytes, 'sharp registry response too large');
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}

export async function materializeSharpRuntimeAssets({ repoRoot, destination, targets = ENTERPRISE_SHARP_TARGETS, fetchArchive = download }) {
  const lockBytes = readFileSync(path.join(repoRoot, 'package-lock.json'));
  const specs = resolveSharpRuntimePackages(JSON.parse(lockBytes), targets);
  requireThat(!existsSync(destination), 'sharp staging destination already exists');
  // The caller selects a fresh host temporary parent (/var is a normal macOS
  // alias). Bind it once; every created descendant must remain link-free.
  destination = path.join(realpathSync(path.dirname(destination)), path.basename(destination));
  assertDirectoryChain(path.dirname(destination));
  mkdirSync(destination, { mode: 0o700 });
  mkdirSync(path.join(destination, 'archives'));
  const receipt = { format: 'otto-sharp-runtime-v1', lockSha256: sha(lockBytes), targets: [...targets], packages: [] };
  for (const spec of specs) {
    const bytes = await fetchArchive(spec);
    const files = verifiedPackageFiles(bytes, spec);
    const archive = `${spec.name.slice(5)}.tgz`;
    writeFileSync(path.join(destination, 'archives', archive), bytes, { flag: 'wx', mode: 0o600 });
    const packageRoot = path.join(destination, spec.location);
    for (const [relative, content] of files) {
      const target = path.join(packageRoot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, { flag: 'wx', mode: 0o644 });
    }
    receipt.packages.push({ ...spec, archive, archiveSha256: sha(bytes), files: Object.fromEntries([...files].map(([name, value]) => [name, sha(value)])) });
  }
  writeFileSync(path.join(destination, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { root: path.resolve(destination), ...receipt };
}

export function verifySharpRuntimeAssets({ repoRoot, destination, targets = ENTERPRISE_SHARP_TARGETS }) {
  assertDirectoryChain(destination);
  const lockBytes = readFileSync(path.join(repoRoot, 'package-lock.json'));
  const specs = resolveSharpRuntimePackages(JSON.parse(lockBytes), targets);
  const receipt = JSON.parse(readFileSync(path.join(destination, 'receipt.json'), 'utf8'));
  requireThat(receipt.format === 'otto-sharp-runtime-v1' && receipt.lockSha256 === sha(lockBytes)
    && JSON.stringify(receipt.targets) === JSON.stringify(targets) && receipt.packages?.length === specs.length, 'sharp receipt source mismatch');
  const expectedFiles = ['receipt.json'];
  for (const [index, spec] of specs.entries()) {
    const archive = `${spec.name.slice(5)}.tgz`;
    const archivePath = path.join(destination, 'archives', archive);
    requireThat(lstatSync(archivePath).isFile() && !lstatSync(archivePath).isSymbolicLink(), 'sharp archive is not an ordinary file');
    const bytes = readFileSync(archivePath);
    const files = verifiedPackageFiles(bytes, spec);
    const expected = { ...spec, archive, archiveSha256: sha(bytes), files: Object.fromEntries([...files].map(([name, value]) => [name, sha(value)])) };
    expectedFiles.push(`archives/${archive}`, ...[...files.keys()].map(name => `${spec.location}/${name}`));
    requireThat(JSON.stringify(receipt.packages[index]) === JSON.stringify(expected), 'sharp receipt package mismatch');
    const packageRoot = path.join(destination, spec.location);
    assertDirectoryChain(packageRoot);
    requireThat(JSON.stringify(filesBelow(packageRoot)) === JSON.stringify([...files.keys()].sort()), 'sharp material file set mismatch');
    for (const [relative, content] of files) requireThat(readFileSync(path.join(packageRoot, relative)).equals(content), 'sharp material bytes mismatch');
  }
  requireThat(JSON.stringify(filesBelow(destination)) === JSON.stringify(expectedFiles.sort()), 'sharp staging contains unexpected files');
  return { root: path.resolve(destination), ...receipt };
}

// The Linux payload is also import-tested on macOS/Windows release builders.
// Put ONLY verified host Sharp optionals in its fresh temporary ancestor, not
// in either release tree. Node's normal resolution serves both staging and
// extracted-archive probes; target manifests/archives remain Linux-only.
export async function prepareEnterpriseSharpSmokeHost({ repoRoot, temporaryRoot, hostTarget = `${process.platform}-${process.arch}`, fetchArchive }) {
  if (ENTERPRISE_SHARP_TARGETS.includes(hostTarget)) return { target: hostTarget, packages: [] };
  temporaryRoot = realpathSync(temporaryRoot);
  assertDirectoryChain(temporaryRoot);
  requireThat(!readdirSync(temporaryRoot).some(name => name.toLowerCase() === 'node_modules'), 'smoke parent node_modules already exists');
  const targets = [hostTarget];
  const assets = await materializeSharpRuntimeAssets({
    repoRoot, destination: path.join(temporaryRoot, 'sharp-host-smoke-assets'), targets, fetchArchive,
  });
  const verified = verifySharpRuntimeAssets({ repoRoot, destination: assets.root, targets });
  for (const spec of verified.packages) {
    const destination = path.join(temporaryRoot, spec.location);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(verified.root, spec.location), destination, { recursive: true, force: false, errorOnExist: true });
  }
  return { target: hostTarget, packages: verified.packages.map(spec => spec.name) };
}
