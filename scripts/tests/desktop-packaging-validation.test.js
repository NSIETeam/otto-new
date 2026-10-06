/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const filename = path.resolve(
  import.meta.dirname,
  '../../.github/workflows/desktop-packaging-validation.yml',
);
const source = existsSync(filename) ? readFileSync(filename, 'utf8') : '';
const workflow = parse(source) ?? {};
const jobs = workflow.jobs ?? {};
const steps = Object.values(jobs).flatMap((job) => job.steps ?? []);
const step = (name) => steps.find((candidate) => candidate.name === name) ?? {};

describe('artifact-only desktop packaging validation', () => {
  it('requires a dedicated manual workflow and read-only repository permission', () => {
    expect(existsSync(filename)).toBe(true);
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on.workflow_dispatch).toBeNull();
  });

  it('admits only the exact latest internal source without retaining checkout credentials', () => {
    const admission = step('Require exact internal source').run ?? '';
    expect(admission).toContain(
      'test "$GITHUB_REPOSITORY" = "NSIETeam/otto-new"',
    );
    expect(admission).toContain('test "$GITHUB_REF" = "refs/heads/internal"');
    expect(admission).toContain('test "$GITHUB_SHA" = "$(git rev-parse HEAD)"');
    expect(admission).toContain(
      'test "$GITHUB_SHA" = "$(git rev-parse origin/internal)"',
    );
    for (const checkout of steps.filter((item) =>
      item.uses?.startsWith('actions/checkout@'),
    )) {
      expect(checkout.with['persist-credentials']).toBe(false);
    }
  });

  it('requires the source-bound attested SQLCipher matrix and verifies its manifest', () => {
    expect(jobs['sqlcipher-native']?.uses).toBe(
      './.github/workflows/sqlcipher-native.yml',
    );
    expect(jobs['sqlcipher-native']?.with).toEqual({
      require_attestation: true,
    });
    expect(jobs.package?.needs).toEqual([
      'validate-source',
      'sqlcipher-native',
    ]);
    const verification =
      step('Verify SQLCipher source and attestations').run ?? '';
    expect(verification).toContain('--expected-build-commit "$GITHUB_SHA"');
    expect(verification).toContain(
      '--expected-source-revision "$SQLCIPHER_SOURCE_REVISION"',
    );
    expect(verification).toContain(
      '--expected-runtime-version "$ELECTRON_VERSION"',
    );
    expect(verification).toContain('--require-matrix-manifest');
    expect(verification).toContain(
      'gh attestation verify native/sqlcipher/matrix-manifest.json',
    );
    expect(verification).toContain('gh attestation verify "$binding"');
  });

  it('builds all three actual installers on their native host with the same current source runtime', () => {
    expect(jobs.package?.strategy?.matrix?.include).toEqual([
      {
        runner: 'windows-2025',
        platform: 'win32',
        arch: 'x64',
        cargo_target: 'x86_64-pc-windows-msvc',
      },
      {
        runner: 'macos-15-intel',
        platform: 'darwin',
        arch: 'x64',
        cargo_target: 'x86_64-apple-darwin',
      },
      {
        runner: 'macos-15',
        platform: 'darwin',
        arch: 'arm64',
        cargo_target: 'aarch64-apple-darwin',
      },
    ]);
    expect(step('Build current-source Otto native runtime').run).toContain(
      '--build-commit "$GITHUB_SHA"',
    );
    expect(step('Build current-source Otto native runtime').run).toContain(
      '--probe',
    );
    expect(step('Build Windows installer').run).toContain(
      '--win nsis --x64 --publish never',
    );
    expect(step('Build macOS disk image').run).toContain(
      '--mac dmg --${{ matrix.arch }} --publish never',
    );
    expect(step('Build macOS disk image').run).toContain(
      '--config.mac.identity=null',
    );
    expect(step('Build application').run).toContain(
      'npm run build --workspace=packages/desktop',
    );
  });

  it('retains the formal installer and ASAR ceilings and uses the existing runtime probes', () => {
    const gate =
      step('Verify final artifact and preserve source-bound receipt').run ?? '';
    expect(gate).toContain('resolveWindowsInstallerBudget');
    expect(gate).toContain('resolveMacInstallerBudget');
    expect(gate).toContain('size > maxBytes');
    expect(gate).toContain('process.env.GITHUB_SHA');
    const probes = step('Probe actual packaged runtime').run ?? '';
    expect(probes).toContain('verify-packaged-content.mjs');
    expect(probes).toContain('--max-bytes 125829120');
    expect(probes).toContain('verify-packaged-runtime.mjs');
    expect(probes).toContain('--expected-build-commit "$GITHUB_SHA"');
    expect(probes).toContain('--probe-native');
    expect(probes).toContain('--probe-server-bin');
    expect(step('Verify macOS disk image and resource seal').run).toContain(
      'hdiutil verify',
    );
    expect(step('Verify macOS disk image and resource seal').run).toContain(
      'codesign --verify --deep --strict',
    );
    expect(source).not.toMatch(
      /OTTO_DESKTOP_(?:MAX|BASELINE)|continue-on-error|\|\| true/,
    );
  });

  it('cannot reach production approval, credentials, release creation or update publishing', () => {
    expect(source).not.toMatch(
      /secrets\.|environment:|contents: write|gh release|gh api|workflow_run|pull_request_target|ssh |scp |latest\.json|make-delivery-zip|--publish always|--publish onTag/,
    );
    expect(Object.keys(jobs)).toEqual([
      'validate-source',
      'sqlcipher-native',
      'package',
    ]);
    expect(jobs.package?.permissions).toEqual({
      contents: 'read',
      attestations: 'read',
    });
    expect(jobs['sqlcipher-native']?.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
      'artifact-metadata': 'write',
    });
    for (const job of Object.values(jobs))
      expect(job.environment).toBeUndefined();
  });

  it('uploads only installers and diagnostic receipts, not an update channel', () => {
    const upload = step('Preserve validation artifacts');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.with?.name).toBe(
      'desktop-packaging-validation-${{ matrix.platform }}-${{ matrix.arch }}-${{ github.sha }}',
    );
    expect(upload.with?.path).toBe(
      'packages/desktop/release/*.exe\npackages/desktop/release/*.dmg\npackages/desktop/release/packaging-validation.json\n',
    );
    expect(upload.if).toBe(
      "${{ always() && steps.package.outcome == 'success' }}",
    );
    expect(upload.with?.['retention-days']).toBe(14);
  });
});
