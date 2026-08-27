/**
 * Generate the isolated Otto Green installer manifest.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GREEN_DISTRIBUTION_ID,
  resolveGreenUpdateAssetBaseUrl,
} from './green-update-config.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const desktopPackage = JSON.parse(
  await readFile(path.join(desktopDir, 'package.json'), 'utf8'),
);

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

export async function createGreenUpdateManifest({
  releaseDir = path.join(desktopDir, 'release-green'),
  version = desktopPackage.version,
  notes = `Otto Green ${version}`,
  assetBaseUrl = resolveGreenUpdateAssetBaseUrl(),
  publishedAt = new Date().toISOString(),
} = {}) {
  const fileName = `Otto.green-${version}.exe`;
  const filePath = path.join(releaseDir, fileName);
  const fileStat = await stat(filePath);
  const manifest = {
    distributionId: GREEN_DISTRIBUTION_ID,
    version,
    notes,
    publishedAt,
    assets: {
      'win-x64': {
        name: fileName,
        url: `${assetBaseUrl}/${fileName}`,
        size: fileStat.size,
        sha256: await sha256(filePath),
      },
    },
  };
  const outputPath = path.join(releaseDir, 'latest.json');
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputPath, manifest };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [notesFile, releaseDir] = process.argv.slice(2);
  const notes = notesFile
    ? await readFile(path.resolve(notesFile), 'utf8')
    : undefined;
  const result = await createGreenUpdateManifest({
    releaseDir: releaseDir ? path.resolve(releaseDir) : undefined,
    notes,
  });
  console.log(`Generated ${result.outputPath}`);
  console.log(
    `  win-x64: ${result.manifest.assets['win-x64'].size} bytes sha256=${result.manifest.assets['win-x64'].sha256}`,
  );
}
