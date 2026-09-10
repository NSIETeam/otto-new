/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { materializeSharpRuntimeAssets, prepareEnterpriseSharpSmokeHost, resolveSharpRuntimePackages, verifiedPackageFiles, verifySharpRuntimeAssets } from '../sharp-runtime-assets.mjs';
import { collectEnterpriseRuntimeDependencies, copyEnterpriseRuntimeDependencies } from '../enterprise-runtime-dependencies.mjs';

const digest = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
function lockFixture() {
  const packages = { 'packages/server': { dependencies: { sharp: '0.35.4' } },
    'node_modules/sharp': { version: '0.35.4', optionalDependencies: {} } };
  for (const target of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']) {
    for (const stem of (target === 'win32-x64' ? ['sharp'] : ['sharp', 'sharp-libvips'])) {
      const name = `@img/${stem}-${target}`;
      const version = stem === 'sharp' ? '0.35.4' : '1.3.3';
      packages['node_modules/sharp'].optionalDependencies[name] = version;
      packages[`node_modules/${name}`] = { version, cpu: [target.split('-')[1]], os: [target.split('-')[0]],
        resolved: `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`, integrity: digest(Buffer.from(name)) };
    }
  }
  return { lockfileVersion: 3, packages };
}

function archive(entries) {
  const parts = [];
  for (const { name, value = '', type = '0' } of entries) {
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

describe('locked target-specific sharp runtime', () => {
  it('selects exactly both Linux glibc pairs, never the build host or every optional target', () => {
    expect(resolveSharpRuntimePackages(lockFixture()).map(item => item.name).sort()).toEqual([
      '@img/sharp-libvips-linux-arm64', '@img/sharp-libvips-linux-x64', '@img/sharp-linux-arm64', '@img/sharp-linux-x64',
    ]);
  });
  it('allows only reviewed explicit targets for desktop reuse', () => {
    expect(resolveSharpRuntimePackages(lockFixture(), ['win32-x64'])).toHaveLength(1);
    expect(() => resolveSharpRuntimePackages(lockFixture(), ['linuxmusl-x64'])).toThrow();
    expect(() => resolveSharpRuntimePackages(lockFixture(), ['linux-x64', 'linux-x64'])).toThrow();
  });
  it.each(['addon', 'libvips', 'integrity', 'registry', 'cpu', 'range', 'sharpVersion'])('rejects incomplete or substituted target closure: %s', variant => {
    const lock = lockFixture();
    const addon = lock.packages['node_modules/@img/sharp-linux-x64'];
    if (variant === 'addon') delete lock.packages['node_modules/@img/sharp-linux-x64'];
    if (variant === 'libvips') delete lock.packages['node_modules/@img/sharp-libvips-linux-x64'];
    if (variant === 'integrity') addon.integrity = 'sha1-weak';
    if (variant === 'registry') addon.resolved = 'https://other.example/package.tgz';
    if (variant === 'cpu') addon.cpu = ['arm64'];
    if (variant === 'range') lock.packages['node_modules/sharp'].optionalDependencies['@img/sharp-linux-x64'] = '^0.35.4';
    if (variant === 'sharpVersion') addon.version = '0.35.3';
    expect(() => resolveSharpRuntimePackages(lock)).toThrow();
  });
  it('does not invent a media dependency for pre-feature source trees', () => {
    expect(resolveSharpRuntimePackages({ lockfileVersion: 3, packages: { 'packages/server': { dependencies: {} } } })).toEqual([]);
  });
});

describe('integrity-checked bounded npm archive (never executes package code)', () => {
  const spec = resolveSharpRuntimePackages(lockFixture(), ['linux-x64'])[0];
  const pkg = JSON.stringify({ name: spec.name, version: spec.version, os: ['linux'], cpu: ['x64'], libc: ['glibc'] });
  const base = [{ name: 'package/package.json', value: pkg }, { name: 'package/LICENSE', value: 'license text' },
    { name: 'package/lib/runtime.node', value: 'native fixture' }];
  it('returns all regular package bytes and license only after whole-archive integrity passes', () => {
    const bytes = archive(base);
    expect([...verifiedPackageFiles(bytes, { ...spec, integrity: digest(bytes) }).keys()]).toEqual(['package.json', 'LICENSE', 'lib/runtime.node']);
    expect(() => verifiedPackageFiles(bytes, { ...spec, integrity: digest(Buffer.from('wrong')) })).toThrow(/integrity/);
  });
  it.each([
    { name: 'package/../outside', value: 'escape' },
    { name: '/absolute', value: 'escape' },
    { name: 'package/C:/outside', value: 'escape' },
    { name: 'package/back\\slash', value: 'escape' },
    { name: 'package/symlink', type: '2' },
    { name: 'package/hardlink', type: '1' },
    { name: 'package/device', type: '3' },
    { name: 'package/package.json', value: pkg },
  ])('rejects unsafe tar entry %j before extracting anything', entry => {
    const bytes = archive([...base, entry]);
    expect(() => verifiedPackageFiles(bytes, { ...spec, integrity: digest(bytes) })).toThrow();
  });
  it('rejects package identity and target substitution despite valid transport hash', () => {
    for (const bad of [{ name: 'evil' }, { version: '0.0.0' }, { cpu: ['arm64'] }, { libc: ['musl'] }]) {
      const bytes = archive([{ name: 'package/package.json', value: JSON.stringify({ ...JSON.parse(pkg), ...bad }) }]);
      expect(() => verifiedPackageFiles(bytes, { ...spec, integrity: digest(bytes) })).toThrow();
    }
  });
});

async function stagedFixture(operation) {
  // Match native require.resolve, including macOS /var -> /private/var.
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'otto-sharp-assets-test-')));
  try {
    const repoRoot = path.join(temporary, 'repo');
    mkdirSync(path.join(repoRoot, 'node_modules/sharp'), { recursive: true });
    const lock = lockFixture();
    const archives = new Map();
    for (const spec of resolveSharpRuntimePackages(lock, ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'])) {
      const bytes = archive([{ name: 'package/package.json', value: JSON.stringify({ name: spec.name, version: spec.version, os: [spec.platform], cpu: [spec.arch], ...(spec.platform === 'linux' ? { libc: ['glibc'] } : {}) }) },
        { name: 'package/lib/runtime.node', value: spec.name }]);
      archives.set(spec.name, bytes);
      lock.packages[spec.location].integrity = digest(bytes);
    }
    writeFileSync(path.join(repoRoot, 'package-lock.json'), JSON.stringify(lock));
    writeFileSync(path.join(repoRoot, 'node_modules/sharp/package.json'), JSON.stringify({ name: 'sharp', version: '0.35.4' }));
    const assets = await materializeSharpRuntimeAssets({ repoRoot, destination: path.join(temporary, 'assets'), fetchArchive: async spec => archives.get(spec.name) });
    await operation({ repoRoot, assets, temporary, lock, fetchArchive: async spec => archives.get(spec.name) });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

describe('materialized runtime source and copy boundary', () => {
  it('copies exactly supported native pairs with provenance and excludes uninstalled other-platform branches', async () => stagedFixture(({ repoRoot, assets, temporary }) => {
    const collected = collectEnterpriseRuntimeDependencies({ repoRoot });
    expect(collected.dependencies.map(item => item.name).sort()).toEqual(['@img/sharp-libvips-linux-arm64', '@img/sharp-libvips-linux-x64', '@img/sharp-linux-arm64', '@img/sharp-linux-x64', 'sharp']);
    verifySharpRuntimeAssets({ repoRoot, destination: assets.root });
    const releaseRoot = path.join(temporary, 'release');
    copyEnterpriseRuntimeDependencies({ repoRoot, releaseRoot, sharpAssetRoot: assets.root });
    expect(existsSync(path.join(releaseRoot, 'node_modules/@img/sharp-linux-arm64/lib/runtime.node'))).toBe(true);
    expect(existsSync(path.join(releaseRoot, 'node_modules/@img/sharp-win32-x64'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(releaseRoot, 'sharp-runtime-provenance.json'), 'utf8')).packages).toHaveLength(4);
  }));
  it('never silently falls back to host npm binaries without verified target assets', async () => stagedFixture(({ repoRoot, temporary }) => {
    const releaseRoot = path.join(temporary, 'release');
    expect(() => copyEnterpriseRuntimeDependencies({ repoRoot, releaseRoot })).toThrow(/verified target-specific/);
    expect(existsSync(releaseRoot)).toBe(false);
  }));
  it.each(['changed-byte', 'extra-native-target', 'changed-lock', 'changed-receipt', 'changed-archive'])('rejects %s before copying any release file', async variant => stagedFixture(({ repoRoot, assets, temporary }) => {
    if (variant === 'changed-byte') writeFileSync(path.join(assets.root, 'node_modules/@img/sharp-linux-x64/lib/runtime.node'), 'corrupt');
    if (variant === 'extra-native-target') {
      mkdirSync(path.join(assets.root, 'node_modules/@img/unknown'));
      writeFileSync(path.join(assets.root, 'node_modules/@img/unknown/package.json'), '{}');
    }
    if (variant === 'changed-lock') writeFileSync(path.join(repoRoot, 'package-lock.json'), `${readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')}\n`);
    if (variant === 'changed-receipt') writeFileSync(path.join(assets.root, 'receipt.json'), '{}');
    if (variant === 'changed-archive') writeFileSync(path.join(assets.root, 'archives/sharp-linux-x64.tgz'), 'corrupt');
    const releaseRoot = path.join(temporary, 'release');
    expect(() => copyEnterpriseRuntimeDependencies({ repoRoot, releaseRoot, sharpAssetRoot: assets.root })).toThrow();
    expect(existsSync(releaseRoot)).toBe(false);
  }));
});

describe('enterprise cross-host smoke bridge (not delivered)', () => {
  it.each(['darwin-arm64', 'darwin-x64', 'win32-x64'])('resolves only %s native smoke assets for staging and extracted archive', async hostTarget => stagedFixture(async ({ repoRoot, assets, temporary, fetchArchive }) => {
    const packageRoot = path.join(temporary, 'package');
    const releaseRoot = path.join(packageRoot, 'release');
    copyEnterpriseRuntimeDependencies({ repoRoot, releaseRoot, sharpAssetRoot: assets.root });
    const before = readFileSync(path.join(releaseRoot, 'sharp-runtime-provenance.json'));
    const hostName = `@img/sharp-${hostTarget}`;
    const requireFrom = root => createRequire(path.join(root, 'node_modules/sharp/dist/sharp.mjs'));
    expect(() => requireFrom(releaseRoot).resolve(`${hostName}/package.json`)).toThrow();
    const receipt = await prepareEnterpriseSharpSmokeHost({ repoRoot, temporaryRoot: temporary, hostTarget, fetchArchive });
    expect(receipt.target).toBe(hostTarget);
    expect(receipt.packages).toHaveLength(hostTarget === 'win32-x64' ? 1 : 2);
    for (const relative of ['package/release', 'archive-smoke/package/release']) {
      const root = path.join(temporary, relative);
      if (root !== releaseRoot) copyEnterpriseRuntimeDependencies({ repoRoot, releaseRoot: root, sharpAssetRoot: assets.root });
      const require = requireFrom(root);
      for (const name of receipt.packages) {
        expect(require.resolve(`${name}/package.json`)).toBe(path.join(temporary, 'node_modules', name, 'package.json'));
        expect(existsSync(path.join(root, 'node_modules', name))).toBe(false);
      }
      expect(require.resolve('@img/sharp-linux-x64/package.json')).toBe(path.join(root, 'node_modules/@img/sharp-linux-x64/package.json'));
      expect(require.resolve('@img/sharp-linux-arm64/package.json')).toBe(path.join(root, 'node_modules/@img/sharp-linux-arm64/package.json'));
    }
    expect(readFileSync(path.join(releaseRoot, 'sharp-runtime-provenance.json'))).toEqual(before);
    expect(JSON.parse(before).targets).toEqual(['linux-x64', 'linux-arm64']);
    expect(existsSync(path.join(packageRoot, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(temporary, 'node_modules/sharp'))).toBe(false);
    for (const name of receipt.packages) {
      const original = path.join(temporary, 'node_modules', name);
      renameSync(original, `${original}-missing`);
      // A fresh process avoids require.resolve's path cache masking removal.
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import { createRequire } from 'node:module';
        createRequire(${JSON.stringify(path.join(releaseRoot, 'node_modules/sharp/dist/sharp.mjs'))}).resolve(${JSON.stringify(`${name}/package.json`)});
      `], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('MODULE_NOT_FOUND');
      renameSync(`${original}-missing`, original);
    }
  }));

  it.each(['linux-x64', 'linux-arm64'])('does not bridge or download on supported native %s', async hostTarget => stagedFixture(async ({ repoRoot, temporary }) => {
    const result = await prepareEnterpriseSharpSmokeHost({ repoRoot, temporaryRoot: temporary, hostTarget, fetchArchive: () => { throw new Error('unexpected download'); } });
    expect(result.packages).toEqual([]);
    expect(existsSync(path.join(temporary, 'node_modules'))).toBe(false);
  }));

  it('rejects corrupted host archives before adding resolution paths', async () => stagedFixture(async ({ repoRoot, temporary }) => {
    await expect(prepareEnterpriseSharpSmokeHost({ repoRoot, temporaryRoot: temporary, hostTarget: 'darwin-arm64', fetchArchive: async () => Buffer.from('corrupt') })).rejects.toThrow(/integrity/);
    expect(existsSync(path.join(temporary, 'node_modules'))).toBe(false);
  }));

  it('rejects an existing parent dependency tree without changing it', async () => stagedFixture(async ({ repoRoot, temporary, fetchArchive }) => {
    mkdirSync(path.join(temporary, 'node_modules'));
    writeFileSync(path.join(temporary, 'node_modules/keep.txt'), 'preserve');
    await expect(prepareEnterpriseSharpSmokeHost({ repoRoot, temporaryRoot: temporary, hostTarget: 'darwin-arm64', fetchArchive })).rejects.toThrow(/already exists/);
    expect(readFileSync(path.join(temporary, 'node_modules/keep.txt'), 'utf8')).toBe('preserve');
  }));

  it('connects the bridge before both genuine startup probes, outside the archived root', () => {
    const source = readFileSync(new URL('../build-enterprise-oneclick.mjs', import.meta.url), 'utf8');
    const prepare = source.indexOf('await prepareEnterpriseSharpSmokeHost(');
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(source.indexOf('smokeEnterpriseRuntime(releaseRoot, smokeDataRoot)'));
    expect(prepare).toBeLessThan(source.indexOf("const archiveSmokeRoot ="));
    expect(source).toContain("['--no-xattrs', '-cf', temporaryTar, '-C', temporaryRoot, finalPackageName]");
  });
});
