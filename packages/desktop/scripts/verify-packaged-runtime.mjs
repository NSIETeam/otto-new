/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { verifyPackagedContent } from './verify-packaged-content.mjs';
import { verifyPackagedOttoNative } from './verify-packaged-otto-native.mjs';
import {
  assertMachOArchitecture,
  verifyRipgrepExecutable,
} from './ripgrep-runtime.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '../..');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function verifyMacCodeSignature(filePath, label) {
  const result = spawnSync(
    'codesign',
    ['--verify', '--strict', '--verbose=2', filePath],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${label} code signature verification failed: status=${String(result.status)} stdout=${JSON.stringify(result.stdout ?? '')} stderr=${JSON.stringify(result.stderr ?? '')}`,
    );
  }
}

function readAsarJson(archivePath, archiveEntry) {
  const nativeEntry = archiveEntry.split('/').join(path.sep);
  return JSON.parse(
    asar.extractFile(archivePath, nativeEntry).toString('utf8'),
  );
}

function requireAsarEntry(entries, archiveEntry) {
  const normalized = `/${archiveEntry.replaceAll('\\', '/')}`;
  if (!entries.has(normalized)) {
    throw new Error(`packaged runtime is missing ${archiveEntry}`);
  }
}

export function probePackagedServerBin(archivePath) {
  const probeRoot = mkdtempSync(path.join(tmpdir(), 'otto-server-bin-probe-'));
  const extractedRoot = path.join(probeRoot, 'app');
  try {
    asar.extractAll(archivePath, extractedRoot);
    const serverBin = path.join(
      extractedRoot,
      'node_modules',
      'otto-server',
      'dist',
      'bin.js',
    );
    const result = spawnSync(process.execPath, [serverBin, 'status'], {
      cwd: extractedRoot,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      env: {
        ...process.env,
        HOME: probeRoot,
        USERPROFILE: probeRoot,
        NODE_ENV: 'test',
        OTTO_DATABASE_ENCRYPTION: 'disabled',
      },
    });
    if (result.error) {
      throw result.error;
    }
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    if (
      result.status !== 1 ||
      !stdout.includes('未发现运行中的 server') ||
      /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/i.test(stderr)
    ) {
      throw new Error(
        `packaged otto-server bin probe failed: status=${String(result.status)} signal=${String(result.signal)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      );
    }
  } finally {
    rmSync(probeRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

function expectedSheetJsVersion(specifier) {
  const match = String(specifier).match(/xlsx-(\d+\.\d+\.\d+)\.tgz$/);
  if (!match) {
    throw new Error(`cannot determine SheetJS version from ${specifier}`);
  }
  return match[1];
}

export function verifyPackagedRuntime(
  archivePath,
  platform = process.platform,
  arch = process.arch,
  expectedBuildCommit = process.env.GITHUB_SHA,
  probeNative = false,
  requireNativeAuthenticode = false,
  requireNativeCodeSignature = false,
) {
  if (!existsSync(archivePath)) {
    throw new Error(`app.asar not found: ${archivePath}`);
  }
  verifyPackagedContent(archivePath);

  const desktopPackage = readJson(path.join(desktopRoot, 'package.json'));
  const serverPackage = readJson(
    path.join(repoRoot, 'packages/server/package.json'),
  );
  const corePackage = readJson(
    path.join(repoRoot, 'packages/core/package.json'),
  );
  const entries = new Set(
    asar.listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/')),
  );

  for (const entry of [
    'dist/main/index.js',
    'dist/preload/index.js',
    'dist/renderer/index.html',
    'node_modules/otto-server/dist/bin.js',
    'node_modules/otto-server/dist/src/bin.js',
    'node_modules/otto-server/dist/src/channelCli.js',
    'node_modules/otto-server/dist/index.js',
    'node_modules/otto-server/package.json',
    'node_modules/qrcode-terminal/package.json',
    'node_modules/qrcode-terminal/lib/main.js',
    'node_modules/otto-core/package.json',
    'node_modules/xlsx/package.json',
    'node_modules/@modelcontextprotocol/sdk/package.json',
  ]) {
    requireAsarEntry(entries, entry);
  }

  const builtinSkillSource = path.join(
    repoRoot,
    'packages',
    'core',
    'skills-seed',
  );
  const builtinSkillNames = readdirSync(builtinSkillSource, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (builtinSkillNames.length === 0) {
    throw new Error('built-in skill source is unexpectedly empty');
  }
  for (const skillName of builtinSkillNames) {
    const skillEntry = `node_modules/otto-core/skills-seed/${skillName}/SKILL.md`;
    requireAsarEntry(entries, skillEntry);
    const instructions = asar
      .extractFile(archivePath, skillEntry.split('/').join(path.sep))
      .toString('utf8')
      .trim();
    if (instructions.length === 0) {
      throw new Error(`packaged built-in skill is empty: ${skillName}`);
    }
  }

  const packagedDesktop = readAsarJson(archivePath, 'package.json');
  const packagedServer = readAsarJson(
    archivePath,
    'node_modules/otto-server/package.json',
  );
  const packagedCore = readAsarJson(
    archivePath,
    'node_modules/otto-core/package.json',
  );
  const packagedXlsx = readAsarJson(
    archivePath,
    'node_modules/xlsx/package.json',
  );
  const packagedMcp = readAsarJson(
    archivePath,
    'node_modules/@modelcontextprotocol/sdk/package.json',
  );
  const packagedQrcode = readAsarJson(
    archivePath,
    'node_modules/qrcode-terminal/package.json',
  );
  const installedQrcode = readJson(
    path.join(repoRoot, 'node_modules/qrcode-terminal/package.json'),
  );

  const expected = {
    desktop: desktopPackage.version,
    server: serverPackage.version,
    core: corePackage.version,
    xlsx: expectedSheetJsVersion(corePackage.dependencies.xlsx),
    mcp: corePackage.dependencies['@modelcontextprotocol/sdk'],
    qrcode: installedQrcode.version,
  };
  const actual = {
    desktop: packagedDesktop.version,
    server: packagedServer.version,
    core: packagedCore.version,
    xlsx: packagedXlsx.version,
    mcp: packagedMcp.version,
    qrcode: packagedQrcode.version,
  };

  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `packaged ${key} version mismatch: expected ${expected[key]}, got ${actual[key]}`,
      );
    }
  }
  if (
    packagedQrcode.name !== 'qrcode-terminal' ||
    packagedQrcode.main !== './lib/main'
  ) {
    throw new Error('packaged qrcode-terminal entrypoint verification failed');
  }

  const nativeRuntime = verifyPackagedOttoNative({
    archivePath,
    platform,
    arch,
    expectedBuildCommit,
    packaged: true,
    requireAuthenticodeSigned: requireNativeAuthenticode,
    requireCodeSignature: requireNativeCodeSignature,
    probe: probeNative,
  });

  const sqlCipherDirectory = path.join(path.dirname(archivePath), 'sqlcipher');
  const sqlCipherBinding = path.join(sqlCipherDirectory, 'better_sqlite3.node');
  const sqlCipherManifest = path.join(sqlCipherDirectory, 'manifest.json');
  const sqlCipherSbom = path.join(sqlCipherDirectory, 'sbom.cdx.json');
  const sqlCipherNotices = path.join(
    sqlCipherDirectory,
    'THIRD_PARTY_NOTICES.md',
  );
  const expectedSqlCipherResourceNames = [
    'THIRD_PARTY_NOTICES.md',
    'better_sqlite3.node',
    'manifest.json',
    'sbom.cdx.json',
  ];
  if (!existsSync(sqlCipherDirectory)) {
    throw new Error(
      `packaged SQLCipher resource directory is missing: ${sqlCipherDirectory}`,
    );
  }
  const packagedSqlCipherResources = readdirSync(sqlCipherDirectory, {
    withFileTypes: true,
  });
  if (
    packagedSqlCipherResources.some((entry) => !entry.isFile()) ||
    packagedSqlCipherResources
      .map((entry) => entry.name)
      .sort()
      .join('\n') !== expectedSqlCipherResourceNames.join('\n')
  ) {
    throw new Error(
      `packaged SQLCipher resource directory contains unexpected files: ${packagedSqlCipherResources
        .map((entry) => entry.name)
        .sort()
        .join(', ')}`,
    );
  }
  for (const required of [
    sqlCipherBinding,
    sqlCipherManifest,
    sqlCipherSbom,
    sqlCipherNotices,
  ]) {
    if (!existsSync(required)) {
      throw new Error(`packaged SQLCipher resource is missing: ${required}`);
    }
  }
  const sqlCipherBytes = readFileSync(sqlCipherBinding);
  const nativeHeader = sqlCipherBytes.subarray(0, 4);
  const validNativeHeader =
    platform === 'win32'
      ? nativeHeader.subarray(0, 2).toString('ascii') === 'MZ'
      : platform === 'linux'
        ? nativeHeader.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        : ['cffaedfe', 'cefaedfe', 'cafebabe', 'cafebabf'].includes(
            nativeHeader.toString('hex'),
          );
  if (!validNativeHeader) {
    throw new Error(
      `packaged SQLCipher resource has wrong platform format: ${sqlCipherBinding}`,
    );
  }
  if (platform === 'darwin') {
    assertMachOArchitecture(sqlCipherBytes, arch, 'packaged SQLCipher runtime');
  }
  const nativeSha256 = createHash('sha256')
    .update(sqlCipherBytes)
    .digest('hex');
  const manifest = readJson(sqlCipherManifest);
  const signedMacSqlCipher =
    platform === 'darwin' && requireNativeCodeSignature;
  if (
    manifest.format !== 3 ||
    manifest.target !== `${platform}-${arch}` ||
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.runtime !== 'electron' ||
    manifest.runtimeVersion !== desktopPackage.build.electronVersion ||
    manifest.toolchain?.electronVersion !== manifest.runtimeVersion ||
    !/^[0-9a-f]{40}$/.test(manifest.buildCommit ?? '') ||
    !/^[0-9a-f]{40}$/.test(manifest.sourceRevision ?? '') ||
    manifest.source !== 'https://github.com/sqlcipher/sqlcipher' ||
    (!signedMacSqlCipher && manifest.sha256 !== nativeSha256) ||
    manifest.cipherSelfTest !== true ||
    manifest.plainSqliteRejected !== true ||
    manifest.sbom?.path !== 'sbom.cdx.json' ||
    manifest.notices?.path !== 'THIRD_PARTY_NOTICES.md'
  ) {
    throw new Error('packaged SQLCipher manifest verification failed');
  }
  if (expectedBuildCommit && manifest.buildCommit !== expectedBuildCommit) {
    throw new Error(
      `packaged SQLCipher build commit mismatch: expected ${expectedBuildCommit}, got ${manifest.buildCommit}`,
    );
  }
  if (signedMacSqlCipher) {
    const sourceDirectory = path.join(
      repoRoot,
      'native',
      'sqlcipher',
      `${platform}-${arch}`,
    );
    const sourceBinding = path.join(sourceDirectory, 'better_sqlite3.node');
    const sourceManifestPath = path.join(sourceDirectory, 'manifest.json');
    if (!existsSync(sourceBinding) || !existsSync(sourceManifestPath)) {
      throw new Error(
        `reviewed SQLCipher source identity is missing: ${sourceDirectory}`,
      );
    }
    const sourceSha256 = createHash('sha256')
      .update(readFileSync(sourceBinding))
      .digest('hex');
    const sourceManifest = readJson(sourceManifestPath);
    if (
      sourceManifest.sha256 !== sourceSha256 ||
      manifest.sha256 !== sourceManifest.sha256
    ) {
      throw new Error('packaged SQLCipher source identity verification failed');
    }
    verifyMacCodeSignature(sqlCipherBinding, 'packaged SQLCipher runtime');
  }
  const expectedSourceRevision = process.env.SQLCIPHER_SOURCE_REVISION;
  if (
    expectedSourceRevision &&
    manifest.sourceRevision !== expectedSourceRevision
  ) {
    throw new Error(
      `packaged SQLCipher source revision mismatch: expected ${expectedSourceRevision}, got ${manifest.sourceRevision}`,
    );
  }
  const sbomSha256 = createHash('sha256')
    .update(readFileSync(sqlCipherSbom))
    .digest('hex');
  if (manifest.sbom.sha256 !== sbomSha256) {
    throw new Error('packaged SQLCipher SBOM checksum verification failed');
  }
  const noticesSha256 = createHash('sha256')
    .update(readFileSync(sqlCipherNotices))
    .digest('hex');
  if (manifest.notices.sha256 !== noticesSha256) {
    throw new Error('packaged SQLCipher notices checksum verification failed');
  }
  const sbom = readJson(sqlCipherSbom);
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  const properties = Array.isArray(sbom.metadata?.properties)
    ? sbom.metadata.properties
    : [];
  const property = (name) =>
    properties.find((entry) => entry?.name === name)?.value;
  if (
    sbom.bomFormat !== 'CycloneDX' ||
    sbom.specVersion !== '1.5' ||
    !components.some((entry) => entry?.name === 'SQLCipher') ||
    !components.some((entry) => entry?.name === 'better-sqlite3') ||
    property('otto:target') !== manifest.target ||
    property('otto:buildCommit') !== manifest.buildCommit ||
    property('otto:sourceRevision') !== manifest.sourceRevision
  ) {
    throw new Error('packaged SQLCipher SBOM identity verification failed');
  }

  if (platform === 'win32' || platform === 'darwin') {
    const ripgrepPath = path.join(
      path.dirname(archivePath),
      'ripgrep',
      platform === 'win32' ? 'rg.exe' : 'rg',
    );
    verifyRipgrepExecutable(ripgrepPath, { platform, arch });
    if (platform === 'darwin' && requireNativeCodeSignature) {
      verifyMacCodeSignature(ripgrepPath, 'packaged ripgrep');
    }
  }

  return { ...actual, nativeRuntime };
}

function main() {
  const archiveArgument = process.argv[2];
  if (!archiveArgument) {
    throw new Error(
      'usage: verify-packaged-runtime.mjs <app.asar> [--platform win32|darwin] [--arch x64|arm64] [--probe-server-bin]',
    );
  }
  const platformIndex = process.argv.indexOf('--platform');
  const platform =
    platformIndex === -1 ? process.platform : process.argv[platformIndex + 1];
  const archIndex = process.argv.indexOf('--arch');
  const arch = archIndex === -1 ? process.arch : process.argv[archIndex + 1];
  const buildCommitIndex = process.argv.indexOf('--expected-build-commit');
  const expectedBuildCommit =
    buildCommitIndex === -1
      ? process.env.GITHUB_SHA
      : process.argv[buildCommitIndex + 1];
  const archivePath = path.resolve(process.cwd(), archiveArgument);
  const versions = verifyPackagedRuntime(
    archivePath,
    platform,
    arch,
    expectedBuildCommit,
    process.argv.includes('--probe-native'),
    process.argv.includes('--require-native-authenticode'),
    process.argv.includes('--require-native-code-signature'),
  );
  if (process.argv.includes('--probe-server-bin')) {
    probePackagedServerBin(archivePath);
  }
  console.log(`[packaged-runtime] verified ${JSON.stringify(versions)}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
