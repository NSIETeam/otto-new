/**
 * Verify that a Green manifest cannot publish a normal Otto installer.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GREEN_DISTRIBUTION_ID,
  resolveGreenUpdateAssetBaseUrl,
} from './green-update-config.mjs';

export async function verifyGreenUpdateManifest({
  releaseDir,
  version,
  assetBaseUrl = resolveGreenUpdateAssetBaseUrl(),
}) {
  if (!releaseDir) throw new Error('releaseDir is required');
  if (!version) throw new Error('version is required');
  const manifest = JSON.parse(
    await readFile(path.join(releaseDir, 'latest.json'), 'utf8'),
  );
  if (manifest.distributionId !== GREEN_DISTRIBUTION_ID) {
    throw new Error('Green latest.json distributionId mismatch');
  }
  if (manifest.version !== version) {
    throw new Error('Green latest.json version mismatch');
  }
  const fileName = `Otto.green-${version}.exe`;
  const asset = manifest.assets?.['win-x64'];
  if (!asset || asset.name !== fileName) {
    throw new Error('Green latest.json win-x64 asset mismatch');
  }
  if (asset.url !== `${assetBaseUrl}/${fileName}`) {
    throw new Error('Green latest.json asset URL mismatch');
  }
  const filePath = path.join(releaseDir, fileName);
  const bytes = await readFile(filePath);
  const fileStat = await stat(filePath);
  if (asset.size !== fileStat.size) {
    throw new Error('Green latest.json asset size mismatch');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (asset.sha256 !== digest) {
    throw new Error('Green latest.json asset sha256 mismatch');
  }
  return { version, fileName, sha256: digest };
}

if (process.argv[1]) {
  const invoked = path.resolve(process.argv[1]);
  if (invoked === fileURLToPath(import.meta.url)) {
    const [releaseDir = 'release-green', requestedVersion] =
      process.argv.slice(2);
    try {
      const packageJson = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      );
      const result = await verifyGreenUpdateManifest({
        releaseDir: path.resolve(releaseDir),
        version: requestedVersion || packageJson.version,
      });
      console.log(
        `[verify-green-update-manifest] ok version=${result.version} file=${result.fileName}`,
      );
    } catch (error) {
      console.error(`[verify-green-update-manifest] failed: ${error.message}`);
      process.exit(1);
    }
  }
}
