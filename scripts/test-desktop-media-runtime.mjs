/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import asar from '@electron/asar';
import { testMediaRuntime } from './test-media-runtime.mjs';
import { collectEnterpriseRuntimeDependencies } from './enterprise-runtime-dependencies.mjs';
import { probePackagedSharp, verifyPackagedSharp } from '../packages/desktop/scripts/sharp-packaging.mjs';

// Narrow real-ASAR acceptance fixture, not a substitute for the full desktop
// builder's afterPack source-byte and native-host executable probes.
export async function testDesktopMediaRuntime({ repoRoot, workDirectory, target, executable }) {
  const result = await testMediaRuntime({ repoRoot, workDirectory, target });
  if (result.applicable === false) return result;
  const proofPath = path.join(workDirectory, 'desktop-result.json');
  const report = { format: 'otto-desktop-media-smoke-v1', passed: false, target, sourceCommit: result.sourceCommit, lockSha256: result.lockSha256 };
  writeFileSync(proofPath, JSON.stringify(report));
  try {
    const source = path.join(workDirectory, 'release');
    const fixtureRoot = path.join(workDirectory, 'asar-input');
    const selected = new Set(['sharp', 'heic-decode', 'libheif-js', 'detect-libc', 'semver', '@img/colour']);
    const closure = collectEnterpriseRuntimeDependencies({ repoRoot, sharpTargets: [target] });
    const keepFile = candidate => !/\.(?:ts|map|h|cc|cpp|c)$/.test(candidate)
      && !/[/\\]sharp[/\\](?:src|install)[/\\]/.test(candidate) && path.basename(candidate) !== 'README.md';
    for (const pkg of closure.dependencies.filter(pkg => selected.has(pkg.name) || pkg.name.startsWith('@img/sharp-'))) {
      cpSync(path.join(source, pkg.target), path.join(fixtureRoot, pkg.target), { recursive: true, filter: keepFile });
    }
    const workerRoot = path.join(fixtureRoot, 'node_modules/otto-server/dist/src/modules/park_services/flea_market');
    mkdirSync(workerRoot, { recursive: true });
    for (const name of ['fleaMarketTypes', 'fleaMarketImageProcessing']) cpSync(path.join(source, 'src/media', `${name}.js`), path.join(workerRoot, `${name}.js`));
    writeFileSync(path.join(fixtureRoot, 'node_modules/otto-server/package.json'), JSON.stringify({ name: 'otto-server', type: 'module' }));
    writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'otto-media-asar-acceptance', version: '1.0.0' }));
    const archivePath = path.join(workDirectory, 'app.asar');
    await asar.createPackageWithOptions(fixtureRoot, archivePath, { unpack: '**/node_modules/{sharp,@img/sharp-*}/**/*' });
    verifyPackagedSharp(archivePath, { target, sourceRoot: repoRoot, assetsRoot: path.join(workDirectory, 'assets'), verifySourceBytes: true });
    report.proof = probePackagedSharp(archivePath, { executable, target, sourceFixture: path.join(repoRoot, 'packages/server/src/modules/park_services/flea_market/fixtures/synthetic.heic') });
    report.passed = true;
    return report;
  } catch (error) { report.error = error.message; throw error; }
  finally { writeFileSync(proofPath, `${JSON.stringify(report, null, 2)}\n`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = { repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') };
  while (args.length) {
    const key = args.shift();
    const name = { '--repo-root': 'repoRoot', '--work-directory': 'workDirectory', '--target': 'target', '--electron': 'executable' }[key];
    if (!name || !args.length) throw new Error('invalid desktop media arguments');
    options[name] = args.shift();
  }
  if (!existsSync(options.executable)) throw new Error('native Electron executable is missing');
  console.log(JSON.stringify(await testDesktopMediaRuntime(options)));
}
