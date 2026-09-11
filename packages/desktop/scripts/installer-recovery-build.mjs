/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  const file = buildInstallerRecovery();
  // Sign with the same configured Windows identity, if present. Unsigned builds
  // remain explicit; no new signing certificate or policy exception is invented.
  await context.packager.signIf(file);
}
