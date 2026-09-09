/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { materializeSharpRuntimeAssets, resolveSharpRuntimePackages, verifySharpRuntimeAssets } from '../../../scripts/sharp-runtime-assets.mjs';
import { mediaProbeProgram } from '../../../scripts/test-media-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stages = new WeakMap();
const imageWorker = 'node_modules/otto-server/dist/src/modules/park_services/flea_market/fleaMarketImageProcessing.js';
const fixture = path.join(repoRoot, 'packages/server/src/modules/park_services/flea_market/fixtures/synthetic.heic');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readAsar = (archive, name) => asar.extractFile(archive, name.split('/').join(path.sep));
const statAsar = (archive, name) => asar.statFile(archive, name.split('/').join(path.sep));
export const SHARP_UNPACK_PATTERNS = Object.freeze(['**/node_modules/sharp/**/*', '**/node_modules/@img/sharp-*/**/*']);
export const SHARP_TARGET_FILTER = Object.freeze(['**/*', '!**/*.h', '!**/README.md']);

export function desktopSharpTarget(context) {
  const arch = context.arch === 1 || context.arch === 'x64' ? 'x64' : context.arch === 3 || context.arch === 'arm64' ? 'arm64' : null;
  const target = `${context.electronPlatformName}-${arch}`;
  if (!['win32-x64', 'darwin-x64', 'darwin-arm64'].includes(target)) throw new Error('unsupported desktop sharp target');
  return { target, arch, osName: context.electronPlatformName === 'win32' ? 'win' : 'mac' };
}
function retainedTargetFile(relative) { return !relative.endsWith('.h') && relative !== 'README.md'; }
export function sharpTargetFileSet(stagingRoot) {
  return { from: path.join(stagingRoot, '${os}-${arch}', 'node_modules'), to: 'node_modules', filter: [...SHARP_TARGET_FILTER] };
}

export async function prepareDesktopSharp(context) {
  const { target, arch, osName } = desktopSharpTarget(context);
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  if (!resolveSharpRuntimePackages(lock, [target]).length) return;
  let stage = stages.get(context.packager.info);
  if (!stage) {
    mkdirSync(context.outDir, { recursive: true });
    stage = { root: mkdtempSync(path.join(realpathSync(context.outDir), '.sharp-runtime-')), targets: new Map() };
    stages.set(context.packager.info, stage);
    const config = context.packager.config;
    // FileSet matchers expand macros per target. Their separate source root
    // prevents host node_modules exclusions affecting reviewed target assets.
    config.files.push(sharpTargetFileSet(stage.root));
  }
  const destination = path.join(stage.root, `${osName}-${arch}`);
  if (stage.targets.has(target)) throw new Error('desktop sharp target preparation was repeated');
  const pending = materializeSharpRuntimeAssets({ repoRoot, destination, targets: [target] });
  stage.targets.set(target, pending);
  await pending;
}

export function verifyPackagedSharp(archivePath, { target, assetsRoot, sourceRoot = repoRoot, verifySourceBytes = false } = {}) {
  const lock = JSON.parse(readFileSync(path.join(sourceRoot, 'package-lock.json'), 'utf8'));
  const specs = resolveSharpRuntimePackages(lock, [target]);
  if (!specs.length) return { applicable: false };
  const expected = new Set(specs.map(spec => spec.name));
  const entries = asar.listPackage(archivePath).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
  const nativeNames = new Set(entries.map(name => name.match(/^node_modules\/(@img\/sharp-[^/]+)/)?.[1]).filter(Boolean));
  if (JSON.stringify([...nativeNames].sort()) !== JSON.stringify([...expected].sort())) throw new Error('packaged sharp contains a missing or foreign native target');
  const required = [imageWorker, 'node_modules/sharp/package.json', 'node_modules/sharp/dist/index.cjs',
    'node_modules/heic-decode/index.js', 'node_modules/heic-decode/lib.js', 'node_modules/libheif-js/wasm-bundle.js', 'node_modules/libheif-js/libheif-wasm/libheif-bundle.js'];
  for (const name of required) if (!entries.includes(name)) throw new Error(`packaged media dependency is missing: ${name}`);
  for (const name of ['sharp', 'heic-decode', 'libheif-js']) {
    const metadata = JSON.parse(readAsar(archivePath, `node_modules/${name}/package.json`));
    if (metadata.name !== name || metadata.version !== lock.packages[`node_modules/${name}`]?.version) throw new Error('packaged media JavaScript identity mismatch');
  }
  let assets;
  if (verifySourceBytes) assets = verifySharpRuntimeAssets({ repoRoot: sourceRoot, destination: assetsRoot, targets: [target] });
  for (const spec of specs) {
    const metadataPath = `${spec.location}/package.json`;
    const metadata = JSON.parse(readAsar(archivePath, metadataPath));
    if (metadata.name !== spec.name || metadata.version !== spec.version
      || JSON.stringify(metadata.os) !== JSON.stringify([spec.platform]) || JSON.stringify(metadata.cpu) !== JSON.stringify([spec.arch])) throw new Error('packaged sharp native identity mismatch');
    const actualFiles = entries.filter(name => name.startsWith(`${spec.location}/`) && !statAsar(archivePath, name).files).map(name => name.slice(spec.location.length + 1));
    const files = assets ? Object.keys(assets.packages.find(pkg => pkg.name === spec.name).files).filter(retainedTargetFile)
      : actualFiles;
    if (assets && JSON.stringify(actualFiles.sort()) !== JSON.stringify([...files].sort())) throw new Error('packaged sharp native file set mismatch');
    if (!files.some(name => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/.test(name))) throw new Error('packaged sharp target binary missing');
    for (const relative of files) {
      const name = `${spec.location}/${relative}`;
      if (!statAsar(archivePath, name).unpacked) throw new Error('sharp native package must be outside asar');
      const content = readAsar(archivePath, name);
      if (verifySourceBytes && hash(content) !== assets.packages.find(pkg => pkg.name === spec.name).files[relative]) throw new Error('packaged sharp target source bytes mismatch');
    }
  }
  for (const name of entries.filter(name => name.startsWith('node_modules/sharp/') && !statAsar(archivePath, name).files)) {
    if (!statAsar(archivePath, name).unpacked) throw new Error('sharp JavaScript must be outside asar');
  }
  return { applicable: true, target, packages: [...expected], sourceBytesVerified: verifySourceBytes };
}

export function probePackagedSharp(archivePath, { executable, target, sourceFixture = fixture } = {}) {
  if (target !== `${process.platform}-${process.arch}`) throw new Error('packaged media probe requires a native target host');
  const work = mkdtempSync(path.join(os.tmpdir(), 'otto-packaged-media-'));
  try {
    const script = path.join(work, 'probe.mjs');
    writeFileSync(script, mediaProbeProgram(path.resolve(archivePath), sourceFixture, imageWorker));
    const result = spawnSync(executable, [script], { cwd: work, encoding: 'utf8', timeout: 45_000, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: work, USERPROFILE: work, TMPDIR: work, TEMP: work, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'test' } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`packaged Electron media probe failed: ${result.stderr}`);
    const proof = JSON.parse(result.stdout.trim());
    if (proof.passed !== true || `${proof.platform}-${proof.arch}` !== target || proof.electron !== '43.2.0'
      || proof.sharp !== '0.35.4' || proof.libvips !== '8.18.6') throw new Error('packaged Electron media proof mismatch');
    return proof;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export async function verifyDesktopSharpBeforeSigning(context) {
  const { target } = desktopSharpTarget(context);
  const stage = stages.get(context.packager.info);
  if (!stage) {
    const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    if (resolveSharpRuntimePackages(lock, [target]).length) throw new Error('desktop sharp preparation did not run');
    return;
  }
  const assets = await stage.targets.get(target);
  if (!assets) throw new Error('desktop sharp target assets missing');
  const name = context.packager.appInfo.productFilename;
  const resources = context.electronPlatformName === 'darwin' ? path.join(context.appOutDir, `${name}.app/Contents/Resources`) : path.join(context.appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  verifyPackagedSharp(archive, { target, assetsRoot: assets.root, verifySourceBytes: true });
  // Cross-built targets get structural/source-byte proof here and actual
  // execution on their own required native media workflow runner.
  if (target === `${process.platform}-${process.arch}`) {
    const executable = context.electronPlatformName === 'darwin' ? path.join(context.appOutDir, `${name}.app/Contents/MacOS/${name}`) : path.join(context.appOutDir, `${name}.exe`);
    const proof = probePackagedSharp(archive, { executable, target });
    writeFileSync(path.join(resources, 'media-runtime-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  }
}
