/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { admittedPaths } from '../probe-windows-crypto-upgrade.cjs';

describe('encrypted data acceptance is a publication gate', () => {
  it('refuses a workstation before loading Electron or touching files', () => {
    expect(() => admittedPaths({ GITHUB_ACTIONS: 'false' }, 'win32')).toThrow(/GitHub-hosted/);
    expect(() => admittedPaths({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows' }, 'win32')).toThrow(/identity/);
    expect(createRequire(import.meta.url).cache).not.toHaveProperty('electron');
  });
  it('seeds encrypted data with the installed historical app before upgrading and verifies with the candidate', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const seed = workflow.indexOf('scripts/run-windows-crypto-upgrade.ps1 -Phase seed');
    const install = workflow.indexOf('- name: Install and load the packaged SQLCipher binding');
    const verify = workflow.indexOf('scripts/run-windows-crypto-upgrade.ps1 -Phase verify');
    expect(seed).toBeGreaterThan(0);
    expect(seed).toBeLessThan(install);
    expect(verify).toBeGreaterThan(install);
    expect(workflow).toContain('windows-crypto-upgrade-${{ needs.build.outputs.version }}');
  });
});
