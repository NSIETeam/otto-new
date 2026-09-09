/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mediaProbeProgram, testMediaRuntime } from '../test-media-runtime.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/media-runtime.yml'), 'utf8');
const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const harness = readFileSync(path.join(root, 'scripts/test-media-runtime.mjs'), 'utf8');

describe('native media acceptance wiring', () => {
  it('executes each Linux target on its actual native runner using only the same checkout and pinned Node', () => {
    expect(workflow).toContain('workflow_call:');
    expect(workflow).toContain('target: linux-x64');
    expect(workflow).toContain('runner: ubuntu-22.04\n');
    expect(workflow).toContain('target: linux-arm64');
    expect(workflow).toContain('runner: ubuntu-22.04-arm');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain("node-version: '22.23.1'");
    expect(workflow).toContain('npm ci --ignore-scripts');
    expect(workflow).not.toMatch(/secrets[.:]|contents: write|id-token:|repository:|continue-on-error|qemu|services:/);
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('if-no-files-found: error');
    for (const uses of workflow.matchAll(/uses: (.+)/g)) expect(uses[1]).toMatch(/@[0-9a-f]{40}\b/);
  });
  it('is required by the same release build before any publication', () => {
    expect(release).toMatch(/media-runtime:\s+needs: validate-source\s+permissions:\s+contents: read\s+uses: \.\/\.github\/workflows\/media-runtime\.yml/);
    const build = release.slice(release.indexOf('\n  build:'), release.indexOf('\n  build:') + 750);
    expect(build).toMatch(/needs:[\s\S]+- media-runtime/);
  });
  it('executes real Electron ASAR probes on each native desktop architecture', () => {
    const desktop = workflow.slice(workflow.indexOf('  desktop-media:'));
    for (const target of ['darwin-x64', 'darwin-arm64', 'win32-x64']) expect(desktop).toContain(`target: ${target}`);
    expect(desktop).toContain('runner: macos-15-intel');
    expect(desktop).toContain('runner: macos-15\n');
    expect(desktop).toContain('runner: windows-2025');
    expect(desktop).toContain('node node_modules/electron/install.js');
    expect(desktop).toContain('scripts/test-desktop-media-runtime.mjs');
    expect(desktop).toContain('desktop-result.json');
  });
  it('uses the copied production worker, verifies isolated module resolution and checks actual JPEG/HEIC pixels', () => {
    const program = mediaProbeProgram('/isolated/release', '/synthetic.heic');
    expect(program).toContain('src/media/fleaMarketImageProcessing.js');
    expect(program).toContain('require.resolve(name)');
    expect(program).toContain('runtime resolution escaped isolated package');
    expect(program).toContain('rotatedMeta.width !== 40');
    expect(program).toContain('pixels[0] < 240');
    expect(program).toContain('invalid image');
    expect(program).not.toMatch(/startEnterprise|listen\(|data\.db|https?:/);
    expect(harness).toContain('spawnSync(process.execPath, [probePath]');
    expect(harness).not.toContain("['--input-type=module'");
  });
});

it('refuses an emulated/cross target before creating work files', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'otto-media-boundary-'));
  try {
    const workDirectory = path.join(temporary, 'work');
    await expect(testMediaRuntime({ target: 'wrong-platform', workDirectory })).rejects.toThrow(/actual native/);
    expect(existsSync(workDirectory)).toBe(false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

it('records missing production dependency/worker mismatch as failure, never a fake skip', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'otto-media-missing-'));
  try {
    const repoRoot = path.join(temporary, 'repo');
    mkdirSync(repoRoot);
    writeFileSync(path.join(repoRoot, 'package-lock.json'), JSON.stringify({ packages: { 'packages/server': { dependencies: { sharp: '0.35.4' } } } }));
    const workDirectory = path.join(temporary, 'work');
    await expect(testMediaRuntime({ repoRoot, target: `${process.platform}-${process.arch}`, workDirectory })).rejects.toThrow(/disagree/);
    const report = JSON.parse(readFileSync(path.join(workDirectory, 'result.json'), 'utf8'));
    expect(report.passed).toBe(false);
    expect(report).not.toHaveProperty('applicable', false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
