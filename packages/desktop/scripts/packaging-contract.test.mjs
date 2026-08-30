/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(packageRoot, '../..');
const require = createRequire(import.meta.url);
const afterPack = require('./after-pack.cjs');

describe('desktop packaging contract', () => {
  it('pins one Electron version across packaging and native build workflows', async () => {
    const [
      rootPackageJson,
      desktopPackageJson,
      packageLock,
      releaseWorkflow,
      nativeWorkflow,
    ] = await Promise.all([
      readFile(path.join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(path.join(packageRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(path.join(repoRoot, 'package-lock.json'), 'utf8').then(
        JSON.parse,
      ),
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'release.yml'),
        'utf8',
      ),
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'sqlcipher-native.yml'),
        'utf8',
      ),
    ]);
    const electronVersion = rootPackageJson.devDependencies.electron;

    expect(electronVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(desktopPackageJson.devDependencies.electron).toBe(electronVersion);
    expect(desktopPackageJson.build.electronVersion).toBe(electronVersion);
    expect(packageLock.packages['node_modules/electron'].version).toBe(
      electronVersion,
    );
    expect(releaseWorkflow).toContain(`ELECTRON_VERSION: '${electronVersion}'`);
    expect(nativeWorkflow).toContain(`ELECTRON_VERSION: ${electronVersion}`);
  });

  it('declares every root-only release script dependency explicitly', async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    expect(rootPackageJson.devDependencies.ora).toBe('^9.0.0');
  });

  it('uses a real multi-resolution ICO for Windows packaging', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.win.icon).toBe('build/icon.ico');

    const icon = await readFile(path.join(packageRoot, 'build', 'icon.ico'));
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    const count = icon.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(4);
    const sizes = new Set();
    for (let index = 0; index < count; index += 1) {
      const entryOffset = 6 + index * 16;
      const widthByte = icon[entryOffset];
      const heightByte = icon[entryOffset + 1];
      const imageSize = icon.readUInt32LE(entryOffset + 8);
      const imageOffset = icon.readUInt32LE(entryOffset + 12);
      sizes.add(widthByte === 0 ? 256 : widthByte);
      expect(heightByte === 0 ? 256 : heightByte).toBe(
        widthByte === 0 ? 256 : widthByte,
      );
      // rcedit writes this size through a 16-bit Windows resource field. A
      // larger PNG is truncated in the final Otto.exe even though the source
      // ICO itself still opens correctly.
      expect(imageSize).toBeLessThanOrEqual(0xffff);
      expect(imageOffset + imageSize).toBeLessThanOrEqual(icon.length);
    }
    for (const size of [16, 32, 48, 256]) {
      expect(sizes.has(size)).toBe(true);
    }
  });

  it('uses a complete multi-resolution ICNS for macOS packaging', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.mac.icon).toBe('build/icon.icns');

    const icon = await readFile(path.join(packageRoot, 'build', 'icon.icns'));
    expect(icon.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icon.readUInt32BE(4)).toBe(icon.length);

    const chunkTypes = new Set();
    let offset = 8;
    while (offset + 8 <= icon.length) {
      const type = icon.subarray(offset, offset + 4).toString('ascii');
      const length = icon.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThanOrEqual(8);
      expect(offset + length).toBeLessThanOrEqual(icon.length);
      chunkTypes.add(type);
      offset += length;
    }
    expect(offset).toBe(icon.length);
    for (const type of ['ic07', 'ic08', 'ic09', 'ic10']) {
      expect(chunkTypes.has(type)).toBe(true);
    }
  });

  it('keeps the public browser previews on their current model display names', async () => {
    const [mockPreview, browserBridge] = await Promise.all([
      readFile(path.join(packageRoot, 'preview', 'mock.tsx'), 'utf8'),
      readFile(
        path.join(packageRoot, 'src', 'renderer', 'browserPreviewBridge.ts'),
        'utf8',
      ),
    ]);
    expect(mockPreview).toContain("displayName: '高端推理模型'");
    expect(browserBridge).toContain("displayName: 'GPT-5.1'");
    expect(browserBridge).not.toContain("displayName: 'gpt-5.1（本地预览）'");
  });

  it('keeps default installers below the lightweight contract by excluding optional runtimes', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    const resources = [
      ...(packageJson.build.mac.extraResources ?? []),
      ...(packageJson.build.win.extraResources ?? []),
    ];
    const bundledInputs = resources.map((resource) => resource.from).join('\n');
    expect(bundledInputs).not.toContain('vendor/runtime');
    expect(bundledInputs).not.toContain('resources/video-editor');
    expect(packageJson.build.mac.extraResources).toEqual([
      { from: 'build/icon.png', to: 'app-icon.png' },
      {
        from: 'vendor/mac/ripgrep/${arch}/rg',
        to: 'ripgrep/rg',
      },
    ]);
    expect(packageJson.build.win.extraResources).toEqual([
      { from: 'build/icon.png', to: 'app-icon.png' },
      { from: 'vendor/win/ripgrep/rg.exe', to: 'ripgrep/rg.exe' },
    ]);
    expect(afterPack.SQLCIPHER_RESOURCE_FILES).toEqual([
      'better_sqlite3.node',
      'manifest.json',
      'sbom.cdx.json',
      'THIRD_PARTY_NOTICES.md',
    ]);
    expect(afterPack.OTTO_NATIVE_RESOURCE_FILES).toEqual(['manifest.json']);
  });

  it('prepares reviewed target-native ripgrep inputs for every Mac packaging entry', async () => {
    const [packageJson, previewWorkflow] = await Promise.all([
      readFile(path.join(packageRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'macos-preview.yml'),
        'utf8',
      ),
    ]);
    expect(packageJson.scripts['prepare:ripgrep:mac']).toBe(
      'node scripts/fetch-mac-ripgrep.mjs',
    );
    for (const scriptName of [
      'dist',
      'dist:dmg',
      'dist:dmg:x64',
      'dist:all',
      'dist:green',
    ]) {
      expect(packageJson.scripts[scriptName]).toContain(
        'npm run prepare:ripgrep:mac',
      );
    }
    expect(packageJson.scripts['dist:all']).toContain(
      'node scripts/fetch-win-ripgrep.mjs',
    );
    const prepareIndex = previewWorkflow.indexOf(
      'run: npm run prepare:ripgrep:mac',
    );
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeLessThan(
      previewWorkflow.indexOf('npx electron-builder --mac'),
    );
  });

  it('never packages local Rust build outputs with the desktop runtime', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    const files = packageJson.build.files;

    expect(files).toContain('!**/node_modules/@otto/native/target/**');
    expect(files).toContain('!**/node_modules/@otto/native/src/**');
    expect(files).toContain('!**/node_modules/@otto/native/node_modules/**');
    expect(files).toContain('!**/node_modules/@otto/native/Cargo.*');
    expect(files).toContain('!**/node_modules/@otto/native/bin/**');
    expect(files).toContain('node_modules/@otto/native/dist/index.js');
    expect(packageJson.build).not.toHaveProperty('asarUnpack');
    expect(packageJson.build.files).toContain(
      '!**/node_modules/pdf-parse/lib/pdf.js/v1.9.426/**',
    );
    expect(packageJson.build.files).toContain(
      '!**/node_modules/better-sqlite3/deps/**',
    );
    expect(packageJson.build.files).toContain(
      '!**/node_modules/better-sqlite3/build/**',
    );
    expect(packageJson.build.files).toContain(
      '!**/node_modules/playwright-core/lib/vite/**',
    );
    expect(afterPack.MAX_APP_ASAR_BYTES).toBe(120 * 1024 * 1024);
  });

  it('does not exclude runtime build/src modules required by ESM dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.files).not.toContain('!**/node_modules/**/src/**');
  });

  it('keeps one CommonJS OpenTelemetry runtime instead of packaging alternate builds', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.files).toEqual(
      expect.arrayContaining([
        '!**/node_modules/@opentelemetry/**/build/esm/**',
        '!**/node_modules/@opentelemetry/**/build/esnext/**',
      ]),
    );
    expect(packageJson.build.files).not.toContain(
      '!**/node_modules/@opentelemetry/**/build/src/**',
    );
  });

  it('keeps the desktop package lean while preserving external runtime entrypoints', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    const files = packageJson.build.files;
    expect(packageJson.build.mac.electronLanguages).toEqual(
      expect.arrayContaining(['en', 'zh_CN', 'zh_TW']),
    );
    for (const exclusion of [
      '!**/node_modules/@otto/native/target/**',
      '!**/node_modules/@otto/native/src/**',
      '!**/node_modules/@otto/native/node_modules/**',
      '!**/node_modules/@otto/native/bin/**',
      '!**/node_modules/better-sqlite3/deps/**',
      '!**/node_modules/better-sqlite3/src/**',
      '!**/node_modules/better-sqlite3/build/**',
      '!**/node_modules/pdf-parse/lib/pdf.js/v1.9.426/**',
      '!**/node_modules/pdf-parse/lib/pdf.js/v1.10.88/**',
      '!**/node_modules/pdf-parse/lib/pdf.js/v2.0.550/**',
      '!**/node_modules/pdf-parse/**/pdf.worker.js',
      '!**/node_modules/playwright/lib/**',
      '!**/node_modules/playwright-core/lib/vite/**',
      '!**/node_modules/playwright-core/lib/tools/**',
      '!**/node_modules/react-dom/**',
      '!**/node_modules/xlsx/dist/**',
      '!**/node_modules/**/spec/**',
      '!**/node_modules/**/specs/**',
      '!**/node_modules/**/__mocks__/**',
      '!**/node_modules/**/__image_snapshots__/**',
      '!**/*.d.cts',
      '!**/*.d.mts',
      '!**/tsconfig*.json',
      '!**/.last_build',
    ]) {
      expect(files).toContain(exclusion);
    }
    expect(files).not.toContain('!**/node_modules/better-sqlite3/lib/**');
    expect(files).not.toContain('!**/node_modules/qrcode-terminal/**');
    expect(afterPack.SQLCIPHER_RESOURCE_FILES).toContain('better_sqlite3.node');
    expect(files).not.toContain(
      '!**/node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js',
    );
    expect(files).not.toContain(
      '!**/node_modules/playwright-core/lib/server/**',
    );
    expect(packageJson.build.files).toContain(
      'node_modules/@otto/native/dist/index.js',
    );
    expect(packageJson.build).not.toHaveProperty('asarUnpack');
  });

  it('runs the shared app.asar content and size gate on every packaged platform', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    const verifier = await readFile(
      path.join(packageRoot, 'scripts', 'verify-packaged-content.mjs'),
      'utf8',
    );
    const runtimeVerifier = await readFile(
      path.join(packageRoot, 'scripts', 'verify-packaged-runtime.mjs'),
      'utf8',
    );
    expect(afterPack.MAX_APP_ASAR_BYTES).toBe(120 * 1024 * 1024);
    expect(afterPack.packagedResourcesRoot).toBeTypeOf('function');
    expect(afterPack.verifyPackagedPayload).toBeTypeOf('function');
    expect(afterPack.copyOttoNativeAsset).toBeTypeOf('function');
    expect(afterPack.finalizePackagedOttoNativeAsset).toBeTypeOf('function');
    expect(verifier).toContain('findForbiddenAsarEntries(entries)');
    expect(verifier).toContain('app.asar exceeds size budget');
    expect(runtimeVerifier).toContain('verifyPackagedContent(archivePath)');
    expect(runtimeVerifier).toContain('verifyPackagedOttoNative({');
    expect(packageJson.build.files).toContainEqual({
      from: '../core/skills-seed',
      to: 'node_modules/otto-core/skills-seed',
      filter: ['**/SKILL.md'],
    });
    expect(packageJson.build.files).toContain(
      '!**/dist/src/utils/testUtils.js',
    );
    expect(packageJson.build.files).toContain(
      '!**/dist/src/utils/test-helpers.js',
    );
    expect(packageJson.build.files).toContain(
      '!**/dist/src/enterprise/fixtures/**',
    );
    expect(runtimeVerifier).toContain("'skills-seed'");
    expect(runtimeVerifier).toContain(
      'node_modules/otto-core/skills-seed/${skillName}/SKILL.md',
    );
    expect(runtimeVerifier).toContain("'node_modules/otto-server/dist/bin.js'");
    expect(runtimeVerifier).toContain(
      "'node_modules/qrcode-terminal/lib/main.js'",
    );
    expect(runtimeVerifier).toContain('probePackagedServerBin(archivePath)');
  });

  it('builds, authenticates, and probes one Otto native runtime per packaged architecture', async () => {
    const [packageJson, workflow, desktopMain] = await Promise.all([
      readFile(path.join(packageRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'release.yml'),
        'utf8',
      ),
      readFile(path.join(packageRoot, 'src', 'main', 'index.ts'), 'utf8'),
    ]);

    for (const target of ['win32-x64', 'darwin-x64', 'darwin-arm64']) {
      expect(workflow).toContain(`target: ${target}`);
      expect(workflow).toContain(`name: otto-native-${target}`);
    }
    for (const cargoTarget of [
      'x86_64-pc-windows-msvc',
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
    ]) {
      expect(workflow).toContain(`cargo_target: ${cargoTarget}`);
    }
    expect(workflow).toContain('node scripts/otto-native-runtime.mjs build');
    expect(workflow).toContain('node scripts/otto-native-runtime.mjs verify');
    expect(workflow).toContain(
      'subject-path: native/otto-native/${{ matrix.target }}/*',
    );
    expect(workflow).toContain("RUST_TOOLCHAIN: '1.97.1'");
    expect(workflow).toContain('rustup toolchain install "$RUST_TOOLCHAIN"');
    expect(workflow).toContain('--toolchain "$RUST_TOOLCHAIN"');
    expect(workflow).toContain('--expected-toolchain "$RUST_TOOLCHAIN"');
    expect(workflow).not.toContain('rustup toolchain install stable');
    expect(workflow).toContain('gh attestation verify "$artifact"');
    expect(workflow).toContain('--probe-native');
    expect(workflow).toContain('--require-native-authenticode');
    expect(workflow).toContain('--require-code-signature');
    expect(workflow).toContain('hdiutil attach -nobrowse -readonly');
    expect(workflow).toContain(
      'Resources/otto-native/darwin-${arch}/otto-native',
    );
    expect(workflow).toContain(
      'Get-AuthenticodeSignature -LiteralPath $nativeRuntime',
    );
    const afterPackSource = await readFile(
      path.join(packageRoot, 'scripts', 'after-pack.cjs'),
      'utf8',
    );
    expect(afterPackSource).toContain(
      'await context.packager.signIf(ottoNativeAsset.binaryPath)',
    );
    expect(afterPackSource).toContain('resolveMacSigningIdentity(context)');
    expect(afterPackSource).toContain("kind: 'codesign'");
    expect(afterPackSource).toContain('verifyCodeSignature(appPath, true)');
    expect(packageJson.build.mac.signIgnore).toEqual([
      '/Contents/Resources/otto-native/',
    ]);
    expect(packageJson.build.files).toContain(
      'node_modules/@otto/native/dist/index.js',
    );
    expect(desktopMain).toContain("'otto-native',");
    expect(desktopMain).toContain('`${process.platform}-${process.arch}`');
    expect(desktopMain).not.toContain("'app.asar.unpacked',");
  });

  it('uses the current dependency collector and verifies the packaged Windows runtime', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build).not.toHaveProperty('includeSubNodeModules');
    expect(packageJson.build.publish).toEqual([
      {
        provider: 'generic',
        url: 'https://59.110.154.44:7777/downloads',
      },
    ]);
    expect(packageJson.scripts['dist:win']).toContain(
      'node scripts/verify-packaged-runtime.mjs release/win-unpacked/resources/app.asar --platform win32 --arch x64 --probe-server-bin',
    );
    expect(packageJson.scripts['dist:win']).toContain('--publish never');
  });

  it('keeps update manifest download URLs bound to the no-proxy update mirror', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    const mirrorConfig = await readFile(
      path.join(packageRoot, 'scripts', 'update-mirror-config.mjs'),
      'utf8',
    );
    expect(script).toContain('resolveUpdateAssetBaseUrl()');
    expect(mirrorConfig).toContain('process.env.OTTO_UPDATE_ASSET_BASE_URL');
    expect(mirrorConfig).toContain('https://59.110.154.44:7777/downloads');
    expect(script).not.toContain(
      'github.com/Felix201209/otto-releases/releases/download',
    );
  });

  it('disables electron-builder implicit publishing for tagged release builds', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    expect(script).toMatch(/'--publish',\s*'never'/);
  });

  it('rejects local direct publication before inspecting or uploading artifacts', async () => {
    const scriptPath = path.join(
      packageRoot,
      'scripts',
      'make-delivery-zip.mjs',
    );
    const [script, packageJson, workflow] = await Promise.all([
      readFile(scriptPath, 'utf8'),
      readFile(path.join(packageRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'release.yml'),
        'utf8',
      ),
    ]);
    const guardIndex = script.indexOf('if (PUBLISH_REQUESTED) {');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(script.indexOf('const GITHUB_TOKEN'));
    expect(script).not.toContain('await publishToGithub(');
    expect(packageJson.scripts.package).toBe(
      'node scripts/make-delivery-zip.mjs',
    );
    expect(packageJson.scripts.release).toBe(
      'node scripts/make-delivery-zip.mjs --build',
    );
    expect(workflow).toContain(
      'run: node scripts/make-delivery-zip.mjs --build',
    );
    expect(workflow).not.toContain('make-delivery-zip.mjs --publish');
    const result = spawnSync(process.execPath, [scriptPath, '--publish'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      '本地 --publish 已禁用',
    );
  });

  it('requires an explicit transition flag before disabling macOS signing', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    const workflow = await readFile(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(script).toContain("process.env.OTTO_ALLOW_UNSIGNED_MAC === '1'");
    expect(script).toContain("'--config.mac.identity=null'");
    expect(script).toContain("'--config.mac.hardenedRuntime=false'");
    expect(script).toContain("'--config.mac.notarize=false'");
    expect(script).toContain("'--config.dmg.sign=false'");
    expect(script).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
    expect(workflow).toContain('unsigned_mac_transition:');
    expect(workflow).toContain(
      "OTTO_ALLOW_UNSIGNED_MAC: ${{ inputs.unsigned_mac_transition == true && inputs.release_channel == 'transition' && inputs.draft == true && inputs.prerelease == true && '1' || '0' }}",
    );
    expect(workflow).toContain('Validate release mode boundary');
    expect(workflow).toContain(
      'Unsigned transition builds require workflow_dispatch, unsigned_mac_transition=true, release_channel=transition, draft=true, and prerelease=true.',
    );
    expect(workflow).toContain(
      'Prerelease artifacts must remain draft-only and cannot deploy or update existing users.',
    );
    expect(workflow).toMatch(
      /sqlcipher-native:\s+[\s\S]*?needs: validate-source\s+[\s\S]*?uses: \.\/\.github\/workflows\/sqlcipher-native\.yml/,
    );
    expect(workflow).toMatch(/otto-native:\s+[\s\S]*?needs: validate-source/);
    expect(workflow).toContain(
      "if: ${{ !(inputs.unsigned_mac_transition == true && inputs.release_channel == 'transition' && inputs.draft == true && inputs.prerelease == true) }}",
    );
    const signedMacStep = workflow.match(
      /- name: Verify signed macOS disk images[\s\S]*?(?=\n\s+- name: Build enterprise server package)/,
    )?.[0];
    expect(signedMacStep).toContain(
      "if: ${{ !(inputs.unsigned_mac_transition == true && inputs.release_channel == 'transition' && inputs.draft == true && inputs.prerelease == true) }}",
    );
    const windowsRuntimeJob = workflow.match(
      /\n  verify-windows-signature:[\s\S]*?(?=\n  create-release-drafts:)/,
    )?.[0];
    expect(windowsRuntimeJob).toContain(
      'name: Verify Windows installer and packaged runtime',
    );
    expect(windowsRuntimeJob).not.toMatch(/timeout-minutes: 15\s+if:/);
    expect(windowsRuntimeJob).toContain(
      "DESKTOP_TEST_BUILD: ${{ inputs.unsigned_mac_transition == true && inputs.release_channel == 'transition' && inputs.draft == true && inputs.prerelease == true && '1' || '0' }}",
    );
    expect(windowsRuntimeJob).toContain(
      "if ($env:DESKTOP_TEST_BUILD -ne '1') {",
    );
    expect(windowsRuntimeJob).toContain(
      "$verificationArguments += '--require-native-authenticode'",
    );
    expect(windowsRuntimeJob).toContain('probe-packaged-sqlcipher.mjs');
    expect(windowsRuntimeJob).toContain("'--probe-native'");
    expect(workflow).toContain(
      'Build unsigned Windows and macOS transition test artifacts',
    );
    expect(workflow).toContain(
      'This draft/prerelease contains unsigned Windows and macOS test artifacts.',
    );
    expect(workflow).toContain(
      'It is not a production release and is not offered through automatic update.',
    );
    expect(workflow).toContain(
      'The production update mirror and enterprise server remain on the previously published stable version.',
    );
  });

  it('runs packaged Electron smoke tests only for the runner native architecture', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    expect(script).toContain("smokeNativeMacArtifact('arm64')");
    expect(script).toContain("smokeNativeMacArtifact('x64')");
    expect(script).toContain('process.arch !== artifactArch');
    expect(script).toContain('跳过 Mac ${artifactArch} 跨架构动态验收');
  });

  it('verifies the final signed Mac native runtime after app signing', async () => {
    const [script, afterPackSource, runtimeVerifier, workflow, fetcher] =
      await Promise.all([
        readFile(
          path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
          'utf8',
        ),
        readFile(path.join(packageRoot, 'scripts', 'after-pack.cjs'), 'utf8'),
        readFile(
          path.join(packageRoot, 'scripts', 'verify-packaged-runtime.mjs'),
          'utf8',
        ),
        readFile(
          path.join(repoRoot, '.github', 'workflows', 'release.yml'),
          'utf8',
        ),
        readFile(
          path.join(packageRoot, 'scripts', 'fetch-mac-ripgrep.mjs'),
          'utf8',
        ),
      ]);
    expect(script).toContain(
      "verifySignedMacApplication('mac-arm64', 'arm64')",
    );
    expect(script).toContain("verifySignedMacApplication('mac', 'x64')");
    expect(script).toContain("path.join(__dirname, 'fetch-mac-ripgrep.mjs')");
    expect(script).toContain("verifyMacPackagedRuntime('mac-arm64', 'arm64')");
    expect(script).toContain("verifyMacPackagedRuntime('mac', 'x64')");
    expect(afterPackSource).toContain('verifyPackagedRipgrep(context)');
    expect(afterPackSource).toContain("'--require-source-digest'");
    expect(afterPackSource).toContain(
      'fileSha256(sourcePath) !== fileSha256(destinationPath)',
    );
    expect(runtimeVerifier).toContain('verifyRipgrepExecutable(');
    expect(runtimeVerifier).toContain('packaged: true');
    expect(runtimeVerifier).toContain(
      "verifyMacCodeSignature(sqlCipherBinding, 'packaged SQLCipher runtime')",
    );
    expect(runtimeVerifier).toContain(
      "verifyMacCodeSignature(ripgrepPath, 'packaged ripgrep')",
    );
    expect(runtimeVerifier).toContain(
      "assertMachOArchitecture(sqlCipherBytes, arch, 'packaged SQLCipher runtime')",
    );
    expect(runtimeVerifier).toContain(
      'manifest.sha256 !== sourceManifest.sha256',
    );
    expect(fetcher).toContain('integrity.archiveSha256');
    expect(fetcher).toContain('requireSourceDigest: true');
    expect(fetcher).toContain('AbortSignal.timeout(downloadTimeoutMs)');
    expect(fetcher).toContain('readBoundedResponseBody(response)');
    expect(script).toContain("inspectMacRipgrep('arm64')");
    expect(script).toContain("inspectMacRipgrep('x64')");
    expect(script).toContain('provenance.inputs?.macRipgrep');
    expect(workflow).toContain(
      'node packages/desktop/scripts/verify-packaged-runtime.mjs',
    );
    expect(workflow).toContain('--require-native-code-signature');
    expect(workflow).toContain(
      'codesign --verify --strict --verbose=2 "$sqlcipher_runtime"',
    );
    expect(script).toContain("'--require-code-signature'");
    expect(script).toContain("'codesign',");
  });

  it('publishes canonical, then mirror, then legacy while retaining enterprise compensation', async () => {
    const [workflow, deliveryScript] = await Promise.all([
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'release.yml'),
        'utf8',
      ),
      readFile(
        path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
        'utf8',
      ),
    ]);
    expect(workflow).toContain('deploy-update-mirror:');
    expect(workflow).toContain('name: Deploy Desktop Update Mirror');
    expect(workflow).toContain('--draft');
    expect(workflow).toContain("needs.deploy-enterprise.result == 'success'");
    expect(workflow).toContain(
      'node packages/desktop/scripts/verify-update-manifest.mjs "$DESKTOP_RELEASE" "$VERSION"',
    );
    expect(workflow).toContain(
      'node packages/desktop/scripts/verify-update-manifest.mjs "mirror-upload" "$VERSION"',
    );
    expect(
      workflow.match(
        /node packages\/desktop\/scripts\/verify-update-manifest\.mjs/g,
      )?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(workflow).not.toContain("['macArm64', 'macX64', 'winX64']");
    expect(workflow).not.toContain("const crypto = require('node:crypto');");
    expect(workflow).toContain('CHECKSUMS="$DESKTOP_RELEASE/SHA256SUMS"');
    expect(workflow).toContain(
      'MIRROR_CHECKSUMS="$DESKTOP_RELEASE/UPDATE-MIRROR-SHA256SUMS"',
    );
    expect(workflow).toContain('copy_one "UPDATE-MIRROR-SHA256SUMS"');
    expect(workflow).toContain('copy_one "UPDATE-MIRROR-SHA256SUMS.sig"');
    expect(workflow).toContain(
      'node scripts/release-payload-signature.mjs verify',
    );
    expect(workflow).toContain(
      'node scripts/update-mirror-manifest.mjs verify',
    );
    expect(workflow).toContain('mirror-upload/UPDATE-MIRROR-SHA256SUMS.sig');
    expect(workflow).toContain('Attest desktop release candidate provenance');
    expect(workflow).toContain(
      'Attest enterprise release candidate provenance',
    );
    expect(workflow).toContain('Attest signed release manifests');
    expect(workflow).toContain('gh attestation verify "$artifact"');
    expect(workflow).toContain('rollback-update-mirror:');
    expect(workflow).toContain('name: Roll back Desktop Update Mirror');
    expect(workflow).toContain('Windows no-proxy download');
    expect(workflow).toContain(
      'if [ "$SOURCE_COMMIT" != "$INTERNAL_COMMIT" ]; then',
    );
    expect(workflow).toContain(
      'Release source must exactly equal the latest origin/internal commit.',
    );
    expect(workflow).toContain('INPUT_VERSION: ${{ inputs.version }}');
    expect(workflow).not.toContain('INPUT_VERSION="${{ inputs.version }}"');
    const windowsVerificationJobStart = workflow.indexOf(
      '  verify-windows-signature:',
    );
    const prepareCreationJobStart = workflow.indexOf(
      '  prepare-release-creation-intent:',
    );
    const createDraftsJobStart = workflow.indexOf('  create-release-drafts:');
    const cleanupDraftsJobStart = workflow.indexOf(
      '  cleanup-partial-release-drafts:',
    );
    expect(workflow.indexOf('name: Upload workflow artifacts')).toBeLessThan(
      windowsVerificationJobStart,
    );
    expect(windowsVerificationJobStart).toBeLessThan(prepareCreationJobStart);
    expect(prepareCreationJobStart).toBeLessThan(createDraftsJobStart);
    expect(workflow).toContain(
      'Release workflow may only run in NSIETeam/otto-new',
    );
    expect(workflow).toContain(
      'git diff --quiet "$INTERNAL_COMMIT" "$SOURCE_COMMIT" -- .github/workflows',
    );
    expect(workflow).toContain(
      'Release workflow changes must land on the default internal branch before creating a release.',
    );
    expect(workflow).toContain('RELEASES_REPO: NSIETeam/otto-new');
    expect(workflow).toContain(
      'LEGACY_RELEASES_REPO: Felix201209/otto-releases',
    );
    expect(workflow).toContain(
      'name: Create canonical and compatibility drafts with GitHub CLI',
    );
    expect(workflow).not.toContain('softprops/action-gh-release@');
    expect(workflow).toContain('gh release create "$TAG" release-assets/*');
    expect(workflow).toContain(
      'source_commit: ${{ needs.validate-source.outputs.source_commit }}',
    );
    expect(workflow).toContain('--target "$SOURCE_COMMIT"');
    expect(workflow).toContain(
      'SOURCE_COMMIT="${{ needs.build.outputs.source_commit }}"',
    );
    expect(workflow).toContain(
      'Canonical draft tag does not resolve to the locked source commit.',
    );

    const validateSourceJobStart = workflow.indexOf('  validate-source:');
    const sqlcipherJobStart = workflow.indexOf('  sqlcipher-native:');
    const buildJobStart = workflow.indexOf('  build:');
    const enterpriseJobStart = workflow.indexOf('  deploy-enterprise:');
    const mirrorJobStart = workflow.indexOf('  deploy-update-mirror:');
    const canonicalJobStart = workflow.indexOf('  publish-canonical:');
    const legacyJobStart = workflow.indexOf('  publish-legacy:');
    const finalizeEnterpriseJobStart = workflow.indexOf(
      '  finalize-enterprise-release-transaction:',
    );
    const rollbackMirrorJobStart = workflow.indexOf(
      '  rollback-update-mirror:',
    );
    const rollbackReleaseJobStart = workflow.indexOf(
      '  rollback-release-publication:',
    );
    const rollbackEnterpriseJobStart = workflow.indexOf(
      '  rollback-enterprise-release-transaction:',
    );
    const validateSourceJob = workflow.slice(
      validateSourceJobStart,
      sqlcipherJobStart,
    );
    const buildJob = workflow.slice(buildJobStart, windowsVerificationJobStart);
    const enterpriseJob = workflow.slice(enterpriseJobStart, mirrorJobStart);
    const mirrorJob = workflow.slice(mirrorJobStart, canonicalJobStart);
    const canonicalJob = workflow.slice(canonicalJobStart, legacyJobStart);
    const legacyJob = workflow.slice(
      legacyJobStart,
      finalizeEnterpriseJobStart,
    );
    const publishJob = workflow.slice(
      canonicalJobStart,
      finalizeEnterpriseJobStart,
    );
    const finalizeEnterpriseJob = workflow.slice(
      finalizeEnterpriseJobStart,
      rollbackMirrorJobStart,
    );
    const rollbackMirrorJob = workflow.slice(
      rollbackMirrorJobStart,
      rollbackReleaseJobStart,
    );
    const rollbackReleaseJob = workflow.slice(
      rollbackReleaseJobStart,
      rollbackEnterpriseJobStart,
    );
    const rollbackEnterpriseJob = workflow.slice(rollbackEnterpriseJobStart);
    expect(validateSourceJob).toContain('permissions:\n      contents: read');
    expect(validateSourceJob).toContain('INPUT_VERSION: ${{ inputs.version }}');
    expect(validateSourceJob).toContain(
      '[[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
    );
    expect(validateSourceJob).toContain(
      '[ "$SOURCE_COMMIT" != "$INTERNAL_COMMIT" ]',
    );
    expect(buildJob).toContain('contents: read');
    expect(buildJob).toContain('artifact-metadata: write');
    expect(buildJob).not.toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(enterpriseJob).toContain('      - verify-windows-signature');
    expect(enterpriseJob).toContain('      - create-release-drafts');
    expect(enterpriseJob).toContain(
      'uses: ./.github/workflows/deploy-server.yml',
    );
    expect(enterpriseJob).toContain(
      'version: ${{ needs.build.outputs.version }}',
    );
    expect(enterpriseJob).toContain(
      'package_identity: ${{ needs.build.outputs.package_identity }}',
    );
    expect(enterpriseJob).toContain('use_workflow_artifact: true');
    expect(enterpriseJob).toContain('defer_finalize: true');
    expect(enterpriseJob).not.toContain('secrets: inherit');
    expect(enterpriseJob).not.toContain('    secrets:');
    expect(buildJob).toContain('    environment: production-approval');
    expect(buildJob).toContain('cd "$(dirname -- "$ENTERPRISE_SHA")"');
    expect(buildJob).toContain(
      'sha256sum -c -- "$(basename -- "$ENTERPRISE_SHA")"',
    );
    expect(buildJob).not.toContain('sha256sum -c "$ENTERPRISE_SHA"');
    expect(mirrorJob).toContain('    environment: production-automation');
    expect(mirrorJob).toContain('      - deploy-enterprise');
    expect(mirrorJob).toContain('      - publish-canonical');
    expect(mirrorJob).toContain('timeout-minutes: 90');
    expect(mirrorJob).toContain(
      'publish-mirror "$MIRROR_TRANSACTION_ID" \\\n            "${{ needs.build.outputs.version }}" \\\n            "${{ needs.build.outputs.package_identity }}" \\\n            "${{ needs.build.outputs.source_commit }}"',
    );
    expect(
      mirrorJob.indexOf('verify_public_release "$RELEASES_REPO"'),
    ).toBeLessThan(
      mirrorJob.indexOf('publish-mirror "$MIRROR_TRANSACTION_ID"'),
    );
    expect(canonicalJob).toContain('      - create-release-drafts');
    expect(canonicalJob).toContain('      - deploy-enterprise');
    expect(canonicalJob).not.toContain('      - deploy-update-mirror');
    expect(canonicalJob).toContain('timeout-minutes: 30');
    expect(legacyJob).toContain('      - publish-canonical');
    expect(legacyJob).toContain('      - deploy-update-mirror');
    expect(legacyJob).toContain('timeout-minutes: 45');
    expect(finalizeEnterpriseJob).toContain('finalize-deployment');
    expect(finalizeEnterpriseJob).toContain('DEPLOY_SSH_KEY:');
    expect(finalizeEnterpriseJob).not.toContain('ROLLBACK_DEPLOY_SSH_KEY:');
    expect(finalizeEnterpriseJob).toContain('for attempt in 1 2 3 4 5 6; do');
    const prepareCreationJob = workflow.slice(
      prepareCreationJobStart,
      createDraftsJobStart,
    );
    const createDraftsJob = workflow.slice(
      createDraftsJobStart,
      cleanupDraftsJobStart,
    );
    const cleanupDraftsJob = workflow.slice(
      cleanupDraftsJobStart,
      enterpriseJobStart,
    );
    expect(createDraftsJob).toContain('      - verify-windows-signature');
    expect(createDraftsJob).toContain('sha256sum -c SHA256SUMS');
    expect(createDraftsJob).toContain(
      'gh attestation verify "$artifact" --repo "$GITHUB_REPOSITORY"',
    );
    expect(createDraftsJob).toContain('EXPECTED_ASSET_COUNT=8');
    expect(createDraftsJob).toContain('EXPECTED_ASSET_COUNT=14');
    expect(createDraftsJob).toContain('copy_one SHA256SUMS.sig');
    expect(createDraftsJob).toContain('copy_one UPDATE-MIRROR-SHA256SUMS');
    expect(createDraftsJob).toContain('copy_one UPDATE-MIRROR-SHA256SUMS.sig');
    expect(createDraftsJob).toContain(
      'gh release create "$TAG" release-assets/*',
    );
    expect(workflow).toContain(
      'group: otto-production-${{ github.repository }}',
    );
    expect(createDraftsJob).toContain(
      'name: Reject existing release or tag state',
    );
    expect(prepareCreationJob).toContain(
      'name: Capture exact release creation intent and pre-public latest',
    );
    expect(prepareCreationJob).toContain(
      'node scripts/release-draft-creation-recovery.mjs \\',
    );
    expect(prepareCreationJob).toContain('capture \\');
    expect(prepareCreationJob).toContain(
      'name: Upload immutable release creation intent before first mutation',
    );
    expect(prepareCreationJob).toContain(
      'name: otto-release-creation-intent-${{ needs.build.outputs.tag }}',
    );
    expect(createDraftsJob).toContain('- prepare-release-creation-intent');
    expect(createDraftsJob).toContain(
      'name: Download immutable release creation intent',
    );
    expect(createDraftsJob).toContain('verify-before-create \\');
    expect(createDraftsJob).toContain('git/matching-refs/tags/${TAG}');
    expect(createDraftsJob).toContain('Refusing to mutate an existing release');
    expect(createDraftsJob).toContain(
      'name: Verify immutable draft state before deployment',
    );
    expect(createDraftsJob).toContain('.target_commitish == $target');
    expect(createDraftsJob).toContain('and .name == $name');
    expect(createDraftsJob).toContain(
      'cmp -- "$NOTES_FILE" "$actual_body_file"',
    );
    expect(createDraftsJob).toContain(
      'all(.assets[]; .state == "uploaded" and .size > 0)',
    );
    expect(createDraftsJob).toContain('$(stat -c \'%s\' "$artifact")');
    expect(createDraftsJob).toContain('(.digest // "")] | @tsv');
    expect(createDraftsJob).toContain(
      'verify_release "$RELEASES_REPO" "$CANONICAL_TOKEN" "$SOURCE_COMMIT"',
    );
    expect(createDraftsJob).toContain(
      'verify_release "$LEGACY_RELEASES_REPO" "$LEGACY_TOKEN" main',
    );
    expect(createDraftsJob.indexOf('verify-before-create \\')).toBeLessThan(
      createDraftsJob.indexOf(
        'name: Create canonical and compatibility drafts with GitHub CLI',
      ),
    );
    expect(cleanupDraftsJob).toContain('always()');
    expect(cleanupDraftsJob).toContain(
      "needs.create-release-drafts.result == 'failure'",
    );
    expect(cleanupDraftsJob).toContain(
      "needs.create-release-drafts.result == 'cancelled'",
    );
    expect(cleanupDraftsJob).toContain('            cleanup \\');
    expect(
      createDraftsJob.indexOf(
        'name: Create canonical and compatibility drafts with GitHub CLI',
      ),
    ).toBeLessThan(
      createDraftsJob.indexOf(
        'name: Verify immutable draft state before deployment',
      ),
    );
    expect(publishJob).toContain(
      'name: Reverify, publish, and reverify canonical release endpoint',
    );
    expect(publishJob).toContain(
      'name: Download immutable release creation intent',
    );
    expect(publishJob).toContain('verify-pre-public-latest');
    expect(publishJob).toContain(
      'PRE_PUBLIC_LATEST_SHA256: ${{ needs.create-release-drafts.outputs.pre_public_latest_sha256 }}',
    );
    expect(publishJob.indexOf('verify-pre-public-latest')).toBeLessThan(
      publishJob.indexOf('GH_TOKEN="$CANONICAL_TOKEN" gh release edit "$TAG"'),
    );
    expect(
      publishJob.indexOf('GH_TOKEN="$CANONICAL_TOKEN" gh release edit "$TAG"'),
    ).toBeLessThan(
      publishJob.indexOf('GH_TOKEN="$LEGACY_TOKEN" gh release edit "$TAG"'),
    );
    expect(publishJob).toContain('gh attestation verify "$artifact"');
    expect(publishJob).toContain('(.digest // "")] | @tsv');
    expect(publishJob).toContain('Release asset changed before publication');
    expect(publishJob).toContain('and .name == $name');
    expect(publishJob).toContain('cmp -- "$NOTES_FILE" "$actual_body_file"');
    expect(publishJob).toContain(
      'verify_release "$LEGACY_RELEASES_REPO" "$LEGACY_TOKEN" main true',
    );
    expect(publishJob).toContain(
      'verify_release "$LEGACY_RELEASES_REPO" "$LEGACY_TOKEN" main false',
    );
    expect(publishJob).toContain(
      'verify_release "$RELEASES_REPO" "$CANONICAL_TOKEN" "$SOURCE_COMMIT" true',
    );
    expect(publishJob).toContain(
      'verify_release "$RELEASES_REPO" "$CANONICAL_TOKEN" "$SOURCE_COMMIT" false',
    );
    expect(publishJob).toContain('Canonical tag changed before publication');
    expect(publishJob).toContain(
      'Canonical release tag changed during publication',
    );
    expect(publishJob).toContain(
      'test "$(find release-assets -maxdepth 1 -type f | wc -l | tr -d \' \')" = 14',
    );
    expect(rollbackMirrorJob).toContain(
      '/usr/local/sbin/otto-enterprise-ci-deploy',
    );
    expect(rollbackMirrorJob).toContain(
      'rollback-mirror "$MIRROR_TRANSACTION_ID"',
    );
    expect(rollbackMirrorJob).toContain('&& github.run_attempt == 1');
    expect(rollbackMirrorJob).toContain('timeout-minutes: 45');
    expect(rollbackMirrorJob).toContain(
      "grep -E '^restored_manifest_sha256=([0-9a-f]{64}|absent)$'",
    );
    expect(rollbackMirrorJob).toContain(
      'for rollback_attempt in 1 2 3 4 5 6; do',
    );
    expect(rollbackMirrorJob).toContain('retrying the idempotent transaction.');
    expect(rollbackMirrorJob).toContain(
      'Public update mirror did not converge to the exact restored manifest; keeping Releases public.',
    );
    expect(rollbackMirrorJob).toContain('if HTTP_STATUS="$(curl --noproxy');
    expect(rollbackReleaseJob).toContain(
      'name: Restore previous latest pointers without retracting Releases',
    );
    expect(rollbackReleaseJob).toContain('&& github.run_attempt == 1');
    expect(rollbackReleaseJob).toContain('timeout-minutes: 40');
    expect(rollbackReleaseJob).toContain(
      'name: Reconfirm mutable release settings before compensation',
    );
    expect(rollbackReleaseJob).toContain(
      'secrets.OTTO_CANONICAL_ADMIN_READ_TOKEN',
    );
    expect(rollbackReleaseJob).toContain(
      'secrets.OTTO_LEGACY_ADMIN_READ_TOKEN',
    );
    expect(
      rollbackReleaseJob.indexOf(
        'name: Reconfirm mutable release settings before compensation',
      ),
    ).toBeLessThan(
      rollbackReleaseJob.indexOf(
        'name: Transactionally restore exact previous latest pointers',
      ),
    );
    expect(rollbackReleaseJob).toContain(
      'name: Download immutable release creation intent',
    );
    expect(rollbackReleaseJob).toContain(
      'node scripts/release-visibility-compensation.mjs \\',
    );
    expect(rollbackReleaseJob).toContain('            compensate \\');
    expect(rollbackReleaseJob).toContain(
      '--pre-public-latest-snapshot release-state/pre-public-latest.json',
    );
    expect(rollbackReleaseJob).toContain(
      '--pre-public-latest-sha256 "${{ needs.create-release-drafts.outputs.pre_public_latest_sha256 }}"',
    );
    expect(rollbackReleaseJob).toContain('      - deploy-update-mirror');
    expect(rollbackReleaseJob).toContain(
      "needs.publish-canonical.result == 'success'",
    );
    expect(rollbackReleaseJob).toContain(
      "needs.deploy-update-mirror.result == 'failure'",
    );
    expect(rollbackReleaseJob).toContain(
      "needs.deploy-update-mirror.result == 'cancelled'",
    );
    expect(rollbackReleaseJob).toContain(
      "needs.deploy-update-mirror.result == 'skipped'",
    );
    expect(rollbackReleaseJob).not.toContain('return_to_draft');
    expect(rollbackReleaseJob).not.toContain('--draft=true');
    expect(rollbackEnterpriseJob).toContain(
      "needs.rollback-release-publication.result == 'success'",
    );
    expect(rollbackEnterpriseJob).toContain(
      "needs.rollback-update-mirror.result == 'success'",
    );
    expect(rollbackEnterpriseJob).toContain('rollback-enterprise');
    expect(rollbackEnterpriseJob).toContain('ROLLBACK_DEPLOY_SSH_KEY:');
    expect(rollbackEnterpriseJob).not.toMatch(/^\s+DEPLOY_SSH_KEY:/m);
    expect(
      workflow.match(/if \[ "\$GITHUB_RUN_ATTEMPT" != '1' \]; then/g)?.length,
    ).toBe(4);
    expect(workflow).not.toContain(
      'secrets.OTTO_RELEASES_TOKEN || secrets.GITHUB_TOKEN',
    );
    expect(workflow).toContain(
      'Require desktop signing and notarization custody',
    );
    expect(workflow).toContain('Verify Windows installer and packaged runtime');
    expect(workflow).toContain(
      "needs.verify-windows-signature.result == 'success'",
    );
    expect(deliveryScript).toContain("['stapler', 'validate', appPath]");
    expect(workflow).not.toContain('This release is unsigned');
    expect(workflow).not.toContain('OTTO_ALLOW_UNSIGNED_ENTERPRISE_PACKAGE');
    expect(workflow).toContain(
      'node scripts/verify-enterprise-package-signature.mjs',
    );
    expect(workflow).toContain(
      'deliverables/otto-enterprise-oneclick-v${{ needs.validate-source.outputs.version }}-*.tar.gz.sig',
    );
    expect(workflow).toContain('probe-packaged-sqlcipher.mjs');
  });

  it('routes production deployment through fixed root-owned gateways', async () => {
    const [releaseWorkflow, deployWorkflow] = await Promise.all([
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'release.yml'),
        'utf8',
      ),
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'deploy-server.yml'),
        'utf8',
      ),
    ]);

    expect(releaseWorkflow).toContain(
      'group: otto-production-${{ github.repository }}',
    );
    expect(deployWorkflow).toContain(
      "format('otto-production-{0}', github.repository)",
    );
    expect(deployWorkflow).toContain('workflow_call:');
    expect(deployWorkflow).toContain('    environment: production-automation');
    expect(deployWorkflow).toContain('use_workflow_artifact:');
    expect(releaseWorkflow).toContain(
      'uses: ./.github/workflows/deploy-server.yml',
    );
    expect(releaseWorkflow).toContain(
      'version: ${{ needs.build.outputs.version }}',
    );
    expect(releaseWorkflow).toContain(
      'package_identity: ${{ needs.build.outputs.package_identity }}',
    );
    expect(releaseWorkflow).toContain(
      'source_commit: ${{ needs.build.outputs.source_commit }}',
    );
    expect(releaseWorkflow).toContain('use_workflow_artifact: true');
    expect(deployWorkflow).toContain(
      'if: ${{ inputs.use_workflow_artifact == true }}',
    );

    for (const workflow of [releaseWorkflow, deployWorkflow]) {
      expect(workflow).not.toContain('DEPLOY_SUDO_PASSWORD');
      expect(workflow).not.toContain('sudo -S');
      expect(workflow).not.toContain('sudo -k -S');
      expect(workflow).not.toContain('deployment-action.txt');
      expect(workflow).not.toContain('DEPLOY_ENTRYPOINT');
      expect(workflow).not.toContain('backup-now.sh');
      expect(workflow).not.toContain('install.sh');
      expect(workflow).not.toContain('upgrade.sh');
      expect(workflow).not.toContain(
        '.github/scripts/publish-update-mirror.sh',
      );
      expect(workflow).not.toContain(
        '.github/scripts/rollback-update-mirror.sh',
      );
      expect(workflow).not.toContain("/bin/bash '$REMOTE_DIR");
      expect(workflow).not.toContain("/bin/bash '$REMOTE_SCRIPT");
    }

    expect(deployWorkflow).toContain(
      '/usr/bin/sudo -n -- /usr/local/sbin/otto-enterprise-ci-deploy',
    );
    expect(deployWorkflow).toContain('deploy "$DEPLOY_TRANSACTION_ID"');
    expect(releaseWorkflow).toContain(
      '/usr/bin/sudo -n -- /usr/local/sbin/otto-enterprise-ci-deploy',
    );
    expect(releaseWorkflow).toContain(
      'publish-mirror "$MIRROR_TRANSACTION_ID" \\\n            "${{ needs.build.outputs.version }}" \\\n            "${{ needs.build.outputs.package_identity }}" \\\n            "${{ needs.build.outputs.source_commit }}"',
    );
    expect(releaseWorkflow).toContain(
      'rollback-mirror "$MIRROR_TRANSACTION_ID"',
    );
  });

  it('uses the shared update manifest verifier in the local release gate', async () => {
    const gate = await readFile(
      path.join(packageRoot, 'scripts', 'release-recovery-gate.mjs'),
      'utf8',
    );
    expect(gate).toContain(
      "import { verifyUpdateManifest } from './verify-update-manifest.mjs'",
    );
    expect(gate).toContain('verifyUpdateManifest({');
    expect(gate).toContain('releaseAssetCandidates.some(existsSync)');
    expect(gate).not.toContain("manifest.assets?.['win-x64']");
    expect(gate).not.toContain('latest.json win-x64 sha256 mismatch');
  });

  it('enforces the public installer baseline and growth budget after the release build', async () => {
    const [gate, budget, workflow] = await Promise.all([
      readFile(
        path.join(packageRoot, 'scripts', 'release-recovery-gate.mjs'),
        'utf8',
      ),
      readFile(
        path.join(packageRoot, 'scripts', 'installer-size-budget.mjs'),
        'utf8',
      ),
      readFile(
        path.join(repoRoot, '.github', 'workflows', 'release.yml'),
        'utf8',
      ),
    ]);
    expect(budget).toContain(
      'LAST_PUBLIC_WINDOWS_INSTALLER_BYTES = 128_032_671',
    );
    expect(budget).toContain('baselineBytes + growthBytes');
    expect(budget).toContain('absoluteMaxBytes');
    expect(gate).toContain('resolveWindowsInstallerBudget()');
    expect(workflow).toContain(
      'name: Enforce packaged content and installer size budget',
    );
    expect(workflow).toContain(
      "OTTO_DESKTOP_BASELINE_INSTALLER_BYTES: '128032671'",
    );
    expect(workflow).toContain("OTTO_DESKTOP_MAX_INSTALLER_GROWTH_MB: '8'");
    expect(workflow).toContain("OTTO_DESKTOP_MAX_INSTALLER_MB: '140'");
  });

  it('discovers every packaged LibreOffice bundle before signing Otto', async () => {
    const appPath = await mkdtemp(path.join(os.tmpdir(), 'otto-after-pack-'));
    try {
      const arm64Bundle = path.join(
        appPath,
        'Contents',
        'Resources',
        'runtime',
        'darwin-arm64',
        'libreoffice',
        'LibreOffice.app',
      );
      const x64Bundle = path.join(
        appPath,
        'Contents',
        'Resources',
        'runtime',
        'darwin-x64',
        'libreoffice',
        'LibreOffice.app',
      );
      await Promise.all([
        mkdir(arm64Bundle, { recursive: true }),
        mkdir(x64Bundle, { recursive: true }),
      ]);

      expect(afterPack.findNestedLibreOfficeBundles(appPath)).toEqual([
        arm64Bundle,
        x64Bundle,
      ]);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });
});
