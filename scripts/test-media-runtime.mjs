/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { copyEnterpriseRuntimeDependencies } from './enterprise-runtime-dependencies.mjs';
import { ENTERPRISE_SHARP_TARGETS, materializeSharpRuntimeAssets } from './sharp-runtime-assets.mjs';

const defaultRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketRelative = 'packages/server/src/modules/park_services/flea_market';

// This program executes the actual production image-worker function emitted
// into an isolated release tree. No application/server/database is started.
export function mediaProbeProgram(releaseRoot, fixture, workerModule = 'src/media/fleaMarketImageProcessing.js') {
  return `
    import { createRequire } from 'node:module';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = ${JSON.stringify(releaseRoot)};
    const require = createRequire(path.join(root, 'media-probe.cjs'));
    for (const name of ['sharp', 'heic-decode', 'libheif-js']) {
      const resolved = fs.realpathSync(require.resolve(name));
      const relative = path.relative(fs.realpathSync(root), resolved);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('runtime resolution escaped isolated package');
    }
    const sharp = require('sharp');
    const { processMarketImage } = await import(pathToFileURL(path.join(root, ${JSON.stringify(workerModule)})));
    const jpeg = await sharp({create:{width:80,height:40,channels:3,background:'#ff0000'}}).withMetadata({orientation:6}).jpeg().toBuffer();
    const rotated = await processMarketImage(jpeg);
    const rotatedMeta = await sharp(rotated.detail).metadata();
    if (rotatedMeta.width !== 40 || rotatedMeta.height !== 80 || rotatedMeta.exif || rotatedMeta.orientation) throw Error('packaged JPEG transform failed');
    const heic = await processMarketImage(fs.readFileSync(${JSON.stringify(fixture)}));
    const pixels = await sharp(heic.detail).raw().toBuffer();
    if (heic.width !== 80 || heic.height !== 40 || pixels[0] < 240 || pixels[1] > 15) throw Error('packaged HEIC pixels failed');
    let rejected = false;
    try { await processMarketImage(Buffer.from('invalid image')); } catch { rejected = true; }
    if (!rejected) throw Error('packaged invalid image accepted');
    console.log(JSON.stringify({passed:true,platform:process.platform,arch:process.arch,node:process.version,electron:process.versions.electron || null,sharp:sharp.versions.sharp,libvips:sharp.versions.vips,jpegOrientation:true,heicRedPixels:true,invalidImageRejected:true}));
  `;
}

export async function testMediaRuntime({ repoRoot = defaultRepo, target, workDirectory }) {
  if (target !== `${process.platform}-${process.arch}`) throw new Error('media smoke requires the actual native target runner');
  if (existsSync(workDirectory)) throw new Error('media smoke work directory must be new');
  workDirectory = path.join(realpathSync(path.dirname(workDirectory)), path.basename(workDirectory));
  mkdirSync(workDirectory, { mode: 0o700 });
  const lockBytes = readFileSync(path.join(repoRoot, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const report = { format: 'otto-media-runtime-smoke-v1', passed: false, target,
    sourceCommit: process.env.GITHUB_SHA || null, lockSha256: createHash('sha256').update(lockBytes).digest('hex') };
  const reportPath = path.join(workDirectory, 'result.json');
  writeFileSync(reportPath, JSON.stringify(report));
  try {
    const hasImageWorker = existsSync(path.join(repoRoot, marketRelative, 'fleaMarketImageProcessing.ts'));
    const hasSharp = !!lock.packages['packages/server']?.dependencies?.sharp;
    if (hasImageWorker !== hasSharp) throw new Error('media worker and production dependency disagree');
    if (!hasSharp) {
      // Transitional source before the independently reviewed feature merge.
      report.applicable = false;
      report.reason = 'media-feature-not-present-in-this-source';
      report.passed = true;
      return report;
    }
    const sharpTargets = target.startsWith('linux-') ? ENTERPRISE_SHARP_TARGETS : [target];
    const assets = await materializeSharpRuntimeAssets({ repoRoot, targets: sharpTargets, destination: path.join(workDirectory, 'assets') });
    const releaseRoot = path.join(workDirectory, 'release');
    copyEnterpriseRuntimeDependencies({ repoRoot, releaseRoot, sharpTargets, sharpAssetRoot: assets.root });
    mkdirSync(path.join(releaseRoot, 'src/media'), { recursive: true });
    writeFileSync(path.join(releaseRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const name of ['fleaMarketTypes', 'fleaMarketImageProcessing']) {
      const fileName = path.join(repoRoot, marketRelative, `${name}.ts`);
      const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), { fileName,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      writeFileSync(path.join(releaseRoot, 'src/media', `${name}.js`), outputText);
    }
    const probePath = path.join(releaseRoot, 'media-probe.mjs');
    writeFileSync(probePath, mediaProbeProgram(releaseRoot, path.join(repoRoot, marketRelative, 'fixtures/synthetic.heic')));
    // A real module file matches production startup. --input-type=module is
    // inherited by eval Workers and incorrectly turns their CJS into ESM.
    const result = spawnSync(process.execPath, [probePath], {
      cwd: releaseRoot, encoding: 'utf8', timeout: 45_000, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: workDirectory, USERPROFILE: workDirectory, TMPDIR: workDirectory, TEMP: workDirectory, NODE_ENV: 'test' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`isolated media worker failed: ${result.stderr}`);
    const proof = JSON.parse(result.stdout.trim());
    if (proof.passed !== true || proof.platform + '-' + proof.arch !== target || proof.sharp !== '0.35.4' || proof.libvips !== '8.18.6') throw new Error('isolated media proof identity mismatch');
    report.proof = proof;
    report.archives = assets.packages.map(({ name, archiveSha256, integrity }) => ({ name, archiveSha256, integrity }));
    report.passed = true;
    return report;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally { writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--repo-root', '--target', '--work-directory'].includes(key) || !args.length) throw new Error('invalid media smoke arguments');
    options[{ '--repo-root': 'repoRoot', '--target': 'target', '--work-directory': 'workDirectory' }[key]] = args.shift();
  }
  console.log(JSON.stringify(await testMediaRuntime(options)));
}
