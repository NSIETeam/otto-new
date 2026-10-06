/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

  it('checks the source budget before downloading or generating native build outputs', () => {
    const packageSteps = jobs.package?.steps ?? [];
    const preflightIndex = packageSteps.findIndex(
      (item) => item.name === 'Check clean source before native artifacts',
    );
    const installIndex = packageSteps.findIndex(
      (item) => item.name === 'Install locked dependencies',
    );
    const downloadIndex = packageSteps.findIndex((item) =>
      item.uses?.startsWith('actions/download-artifact@'),
    );
    const nativeBuildIndex = packageSteps.findIndex(
      (item) => item.name === 'Build current-source Otto native runtime',
    );
    expect(preflightIndex).toBeGreaterThan(installIndex);
    expect(preflightIndex).toBeLessThan(downloadIndex);
    expect(preflightIndex).toBeLessThan(nativeBuildIndex);
    const preflight = packageSteps[preflightIndex]?.run ?? '';
    expect(preflight).toContain('npm run doctor');
    expect(preflight).toContain('npm run code-map:check');
    expect(preflight).toContain('git diff --check');
    expect(step('Build application').run).not.toContain('npm run doctor');
    expect(source).not.toContain('OTTO_DOCTOR_SOURCE_SIZE_BUDGET_MB');
  });

  it('prepares reviewed ripgrep before lifecycle execution without leaking a token or dropping hooks', () => {
    const install = step('Install locked dependencies');
    expect(install.env?.TARGET_PLATFORM).toBe('${{ matrix.platform }}');
    const commands = install.run ?? '';
    expect(commands).toContain('if [ "$TARGET_PLATFORM" = win32 ]; then');
    expect(commands).toContain('npm ci --ignore-scripts');
    expect(commands).toContain('node packages/desktop/scripts/fetch-win-ripgrep.mjs');
    expect(commands).toContain('COPYFILE_EXCL');
    expect(commands).toContain('requireSourceDigest: true');
    expect(commands).toContain('npm rebuild --foreground-scripts');
    expect(commands).toContain('npm run postinstall --if-present');
    expect(commands.indexOf('npm ci --ignore-scripts')).toBeLessThan(
      commands.indexOf('node packages/desktop/scripts/fetch-win-ripgrep.mjs'),
    );
    expect(commands.indexOf('COPYFILE_EXCL')).toBeLessThan(
      commands.indexOf('npm rebuild --foreground-scripts'),
    );
    const mac = commands.split(/\n\s*else\n/)[1] ?? '';
    expect(mac).toContain('node packages/desktop/scripts/prime-vscode-ripgrep-cache.mjs');
    expect(mac.indexOf('prime-vscode-ripgrep-cache.mjs')).toBeLessThan(
      mac.indexOf('npm ci'),
    );
    expect(commands).toContain('ripgrep-runtime.mjs "$RIPGREP"');
    expect(commands).toContain('--platform "$TARGET_PLATFORM" --arch "$ARCH" --require-source-digest');
    expect(commands).toContain('ripgrep 15.0.0');
    expect(install.env).not.toHaveProperty('GH_TOKEN');
    expect(install.env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('executes the actual Windows bootstrap with integrity, no-overwrite and link protections', () => {
    const bootstrap = (step('Install locked dependencies').run ?? '').match(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/,
    )?.[1];
    expect(bootstrap).toBeTruthy();
    const fixture = mkdtempSync(path.join(tmpdir(), 'otto-ripgrep-bootstrap-'));
    try {
      const scripts = path.join(fixture, 'packages/desktop/scripts');
      const vendor = path.join(fixture, 'packages/desktop/vendor/win/ripgrep');
      const library = path.join(fixture, 'node_modules/@vscode/ripgrep/lib');
      const bin = path.join(fixture, 'node_modules/@vscode/ripgrep/bin');
      for (const folder of [scripts, vendor, library]) mkdirSync(folder, { recursive: true });
      copyFileSync(path.resolve(path.dirname(filename), '../../packages/desktop/scripts/ripgrep-runtime.mjs'), path.join(scripts, 'ripgrep-runtime.mjs'));
      const bytes = Buffer.alloc(1024 * 1024);
      bytes.write('MZ');
      const digest = createHash('sha256').update(bytes).digest('hex');
      // Isolated synthetic verifier fixture, not a claim of upstream provenance.
      writeFileSync(path.join(scripts, 'ripgrep-integrity.mjs'),
        `export const MACOS_RIPGREP_INTEGRITY = {};\nexport const WINDOWS_RIPGREP_INTEGRITY = {'v15.0.0': { executableSha256: '${digest}' }};\n`);
      writeFileSync(path.join(library, 'postinstall.js'), "const VERSION = 'v15.0.0';\n");
      const sourceFile = path.join(vendor, 'rg.exe');
      const destination = path.join(bin, 'rg.exe');
      writeFileSync(sourceFile, bytes);
      const run = () => spawnSync(process.execPath, ['--input-type=module', '--eval', bootstrap], { cwd: fixture, encoding: 'utf8', timeout: 15000, windowsHide: true });
      expect(run().status).toBe(0);
      expect(readFileSync(destination)).toEqual(bytes);

      const preserved = Buffer.from('previous fixture, never overwrite');
      writeFileSync(destination, preserved);
      expect(run().status).not.toBe(0);
      expect(readFileSync(destination)).toEqual(preserved);
      rmSync(bin, { recursive: true });

      const corrupt = Buffer.from(bytes);
      corrupt[100] = 1;
      writeFileSync(sourceFile, corrupt);
      expect(run().stderr).toContain('SHA256 mismatch');
      expect(existsSync(bin)).toBe(false);
      writeFileSync(sourceFile, bytes);

      const linkTarget = path.join(fixture, 'owned-link-target');
      mkdirSync(linkTarget);
      symlinkSync(linkTarget, bin, 'junction');
      expect(run().stderr).toContain('symbolic link');
      expect(existsSync(path.join(linkTarget, 'rg.exe'))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('revalidates both native matrices when the diagnostic packaging pipeline changes', () => {
    for (const nativeWorkflow of ['media-runtime.yml', 'sqlcipher-native.yml']) {
      const native = parse(readFileSync(path.join(path.dirname(filename), nativeWorkflow), 'utf8'));
      for (const event of ['pull_request', 'push']) {
        expect(native.on[event].paths).toContain(
          '.github/workflows/desktop-packaging-validation.yml',
        );
      }
    }
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
