/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const currentCommit = () => execFileSync('git', ['-c', `safe.directory=${root}`, '-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
function readBounded(file, maximum) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > maximum) throw new Error('Invalid recovery artifact file');
  return readFileSync(file);
}
export function verifyInstallerRecoveryArtifact(directory, expectedCommit) {
  const manifest = JSON.parse(readBounded(path.join(directory, 'manifest.json'), 8192).toString('utf8'));
  const binary = readBounded(path.join(directory, 'InstallerRecovery.exe'), 2 * 1024 * 1024);
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit) || manifest.schema !== 'otto-installer-recovery-v1' ||
      manifest.sourceCommit !== expectedCommit || manifest.binarySha256 !== hash(binary) ||
      manifest.sourceSha256 !== hash(readFileSync(path.join(desktop, 'build/InstallerRecovery.cs'))) ||
      binary.subarray(0, 2).toString() !== 'MZ') throw new Error('Recovery artifact source or binary identity mismatch');
  return binary;
}
export function buildInstallerRecoveryArtifact(directory, expectedCommit) {
  if (currentCommit() !== expectedCommit) throw new Error('Recovery build source is not the frozen commit');
  const file = buildInstallerRecovery(path.join(directory, 'InstallerRecovery.exe'));
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    schema: 'otto-installer-recovery-v1', sourceCommit: expectedCommit,
    sourceSha256: hash(readFileSync(path.join(desktop, 'build/InstallerRecovery.cs'))),
    binarySha256: hash(readFileSync(file)),
  }) + '\n', { flag: 'wx' });
  verifyInstallerRecoveryArtifact(directory, expectedCommit);
}
export function buildInstallerRecovery(output = path.join(desktop, 'build/InstallerRecovery.exe')) {
  if (process.platform !== 'win32') throw new Error('The Windows recovery helper must be built on Windows');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/warnaserror+', '/utf8output', '/reference:System.Windows.Forms.dll', '/reference:System.Runtime.Serialization.dll', '/out:' + output, path.join(desktop, 'build/InstallerRecovery.cs')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Recovery helper build failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  if (readFileSync(output).subarray(0, 2).toString() !== 'MZ') throw new Error('Recovery helper is not a Windows executable');
  return output;
}
export async function prepareInstallerRecovery(context) {
  if (context.electronPlatformName !== 'win32') return;
  const file = path.join(desktop, 'build/InstallerRecovery.exe');
  if (process.env.OTTO_INSTALLER_RECOVERY_ARTIFACT) {
    // The release workflow downloads and attests this same-run Windows build.
    // Recheck exact source and binary before copying it into NSIS resources.
    const binary = verifyInstallerRecoveryArtifact(process.env.OTTO_INSTALLER_RECOVERY_ARTIFACT, currentCommit());
    writeFileSync(file, binary);
  } else {
    buildInstallerRecovery(file);
  }
  // Sign with the same configured Windows identity, if present. Unsigned builds
  // remain explicit; no new signing certificate or policy exception is invented.
  await context.packager.signIf(file);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, directory, commit] = process.argv.slice(2);
  if (!directory || !commit) throw new Error('Usage: installer-recovery-build.mjs <build-artifact|verify-artifact> <directory> <source-commit>');
  if (mode === 'build-artifact') buildInstallerRecoveryArtifact(directory, commit);
  else if (mode === 'verify-artifact') verifyInstallerRecoveryArtifact(directory, commit);
  else throw new Error('Unknown recovery build operation');
  console.log('Installer recovery artifact identity verified');
}
