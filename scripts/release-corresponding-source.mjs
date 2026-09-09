/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function correspondingSourceAssetNames(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
    throw new Error('Invalid source version');
  const archive = `otto-${version}-corresponding-source.tar.gz`;
  return [archive, `${archive}.sha256`];
}

export function correspondingSourceNotes(version) {
  const [archive] = correspondingSourceAssetNames(version);
  return (
    '\n\n### Corresponding source and license materials\n\n' +
    `Free source archive: [canonical GitHub download](https://github.com/NSIETeam/otto-new/releases/download/v${version}/${archive}) ` +
    `([legacy GitHub download](https://github.com/Felix201209/otto-releases/releases/download/v${version}/${archive})).\n` +
    'The same source archive applies to the mirror installers. It is a separate download, not part of the installer or the seven-file update-mirror payload. ' +
    'See its README, source-inputs.json and NOTICE for exact components, build/recombination instructions and verification limits. ' +
    'Verify the archive against its .sha256 companion and the release SHA256SUMS; production SHA256SUMS has an Ed25519 signature.\n'
  );
}

async function ordinaryFile(file) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0)
    throw new Error('Source release input is not an ordinary nonempty file');
  return metadata;
}

export async function prepareCorrespondingSourceRelease({
  directory,
  receiptPath,
  desktopDirectory,
  version,
  sourceCommit,
}) {
  const [archive, checksum] = correspondingSourceAssetNames(version);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit))
    throw new Error('Invalid source commit');
  const sourceDirectory = path.resolve(directory);
  const desktop = path.resolve(desktopDirectory);
  for (const root of [sourceDirectory, desktop]) {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('Source release directory is unsafe');
  }
  const archivePath = path.join(sourceDirectory, archive);
  const sha256Path = path.join(sourceDirectory, checksum);
  if ((await ordinaryFile(receiptPath)).size > 8192)
    throw new Error('Source receipt is oversized');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (
    !receipt ||
    Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(',') !==
      'archivePath,sha256,sha256Path,sourceCommit,version' ||
    receipt.archivePath !== archivePath ||
    receipt.sha256Path !== sha256Path ||
    receipt.sourceCommit !== sourceCommit ||
    receipt.version !== version ||
    !/^[0-9a-f]{64}$/.test(receipt.sha256 ?? '')
  )
    throw new Error('Source receipt identity mismatch');
  await ordinaryFile(archivePath);
  if ((await ordinaryFile(sha256Path)).size > 1024)
    throw new Error('Source checksum is oversized');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archivePath)) digest.update(chunk);
  if (
    digest.digest('hex') !== receipt.sha256 ||
    (await readFile(sha256Path, 'utf8')) !== `${receipt.sha256}  ${archive}\n`
  )
    throw new Error('Source archive/checksum bytes mismatch');

  // Validate both manifests before writing either. Only notes change: updater
  // schema, asset URLs, lengths/digests and publication timestamp stay intact.
  const updates = [];
  for (const name of ['latest.json', 'latest.mirror.json']) {
    const filename = path.join(desktop, name);
    if ((await ordinaryFile(filename)).size > 1024 * 1024)
      throw new Error('Update manifest is oversized');
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    if (manifest?.version !== version || typeof manifest.notes !== 'string')
      throw new Error('Update manifest source identity mismatch');
    updates.push([
      filename,
      `${JSON.stringify({ ...manifest, notes: manifest.notes + correspondingSourceNotes(version) }, null, 2)}\n`,
    ]);
  }
  for (const [filename, contents] of updates)
    await writeFile(filename, contents);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [
    directory,
    receiptPath,
    desktopDirectory,
    version,
    sourceCommit,
    ...extra
  ] = process.argv.slice(2);
  if (!sourceCommit || extra.length)
    throw new Error(
      'Usage: SOURCE_DIR RECEIPT_FILE DESKTOP_DIR VERSION SOURCE_COMMIT',
    );
  await prepareCorrespondingSourceRelease({
    directory,
    receiptPath,
    desktopDirectory,
    version,
    sourceCommit,
  });
}
