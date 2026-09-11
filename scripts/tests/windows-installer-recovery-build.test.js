import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyInstallerRecoveryArtifact } from '../../packages/desktop/scripts/installer-recovery-build.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const source = readFileSync('packages/desktop/build/InstallerRecovery.cs');
const commit = 'a'.repeat(40);
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'otto-recovery-artifact-'));
  const binary = Buffer.from('MZ-isolated-artifact-test-not-executable');
  const manifest = { schema: 'otto-installer-recovery-v1', sourceCommit: commit, sourceSha256: sha(source), binarySha256: sha(binary) };
  writeFileSync(path.join(directory, 'InstallerRecovery.exe'), binary);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, manifest };
}
describe('Windows recovery artifact custody on non-Windows packaging hosts', () => {
  it('accepts only the exact source and binary manifest', () => {
    const { directory } = fixture();
    expect(verifyInstallerRecoveryArtifact(directory, commit)).toEqual(readFileSync(path.join(directory, 'InstallerRecovery.exe')));
  });
  it.each(['sourceCommit', 'sourceSha256', 'binarySha256', 'schema'])('rejects changed %s', field => {
    const { directory, manifest } = fixture();
    manifest[field] = 'changed';
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    expect(() => verifyInstallerRecoveryArtifact(directory, commit)).toThrow();
  });
  it('rejects corrupted and missing executables', () => {
    const { directory } = fixture();
    writeFileSync(path.join(directory, 'InstallerRecovery.exe'), 'broken');
    expect(() => verifyInstallerRecoveryArtifact(directory, commit)).toThrow();
    expect(() => verifyInstallerRecoveryArtifact(path.join(directory, 'absent'), commit)).toThrow();
  });
  it('builds on Windows, attests and downloads in the same release run before packaging', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(workflow.includes('Build Windows installer recovery helper')).toBe(true);
    expect(workflow.includes('Attest Windows installer recovery helper')).toBe(true);
    expect(workflow.includes('Download Windows installer recovery helper')).toBe(true);
    expect(workflow.includes('OTTO_INSTALLER_RECOVERY_ARTIFACT:')).toBe(true);
    expect(workflow.indexOf('Download Windows installer recovery helper')).toBeLessThan(workflow.indexOf('Build desktop release artifacts'));
  });
});
