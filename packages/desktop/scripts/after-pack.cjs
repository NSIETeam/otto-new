/**
 * electron-builder 打包后钩子。
 *
 * 公开测试渠道暂未使用 Apple Developer ID；electron-builder 在 identity:null
 * 时只留下 linker 签名，资源没有封存，经过下载隔离后容易被 Gatekeeper 判成
 * “App 已损坏”。这里为 macOS bundle 补完整的深度 ad-hoc 签名并立即严格校验。
 * 它不能替代 Apple 公证，但能确保 DMG 中的 App 自身结构和资源封存有效。
 */

const { execFileSync } = require('node:child_process');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} = require('node:fs');
const path = require('node:path');

const MAX_APP_ASAR_BYTES = 120 * 1024 * 1024;

function packagedResourcesRoot(context) {
  return context.electronPlatformName === 'darwin'
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources',
      )
    : path.join(context.appOutDir, 'resources');
}

function verifyPackagedPayload(context) {
  const resourcesRoot = packagedResourcesRoot(context);
  const appAsar = path.join(resourcesRoot, 'app.asar');
  const size = statSync(appAsar).size;
  if (size > MAX_APP_ASAR_BYTES) {
    throw new Error(
      `[after-pack] app.asar ${(size / 1024 / 1024).toFixed(1)} MiB exceeds the 120 MiB contract`,
    );
  }

  const rustBuildOutput = path.join(
    resourcesRoot,
    'app.asar.unpacked',
    'node_modules',
    '@otto',
    'native',
    'target',
  );
  if (existsSync(rustBuildOutput)) {
    throw new Error('[after-pack] local @otto/native target output leaked into the application');
  }
  console.log(`[after-pack] 应用负载门禁通过：app.asar ${(size / 1024 / 1024).toFixed(1)} MiB`);
}

function electronBuilderArchName(value) {
  if (value === 'x64' || value === 1) return 'x64';
  if (value === 'arm64' || value === 3) return 'arm64';
  throw new Error(`[after-pack] unsupported SQLCipher architecture: ${value}`);
}

function copySqlCipherNativeAsset(context) {
  const platform = context.electronPlatformName;
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`[after-pack] unsupported SQLCipher platform: ${platform}`);
  }
  const arch = electronBuilderArchName(context.arch);
  const target = `${platform}-${arch}`;
  const repoRoot = path.resolve(__dirname, '../../..');
  const sourceRoot = path.join(repoRoot, 'native', 'sqlcipher');
  const verifyArguments = [
    path.join(repoRoot, 'scripts', 'verify-sqlcipher-native-assets.mjs'),
    '--root',
    sourceRoot,
    '--target',
    target,
  ];
  if (process.env.GITHUB_SHA) {
    verifyArguments.push('--expected-build-commit', process.env.GITHUB_SHA);
  }
  if (process.env.SQLCIPHER_SOURCE_REVISION) {
    verifyArguments.push(
      '--expected-source-revision',
      process.env.SQLCIPHER_SOURCE_REVISION,
    );
  }
  if (context.packager.config.electronVersion) {
    verifyArguments.push(
      '--expected-runtime-version',
      context.packager.config.electronVersion,
    );
  }
  execFileSync(process.execPath, verifyArguments, { stdio: 'inherit' });
  const resourcesRoot = packagedResourcesRoot(context);
  const destination = path.join(resourcesRoot, 'sqlcipher');
  mkdirSync(destination, { recursive: true });
  for (const name of [
    'better_sqlite3.node',
    'manifest.json',
    'sbom.cdx.json',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    copyFileSync(
      path.join(sourceRoot, target, name),
      path.join(destination, name),
    );
  }
  console.log(`[after-pack] SQLCipher native asset copied: ${target}`);
}

function findNestedLibreOfficeBundles(appPath) {
  const runtimeRoot = path.join(appPath, 'Contents', 'Resources', 'runtime');
  if (!existsSync(runtimeRoot)) return [];

  return readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path.join(runtimeRoot, entry.name, 'libreoffice', 'LibreOffice.app'),
    )
    .filter(existsSync)
    .sort();
}

async function afterPack(context) {
  verifyPackagedPayload(context);
  copySqlCipherNativeAsset(context);
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  for (const libreOfficePath of findNestedLibreOfficeBundles(appPath)) {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', libreOfficePath],
      { stdio: 'inherit' },
    );
    execFileSync(
      'codesign',
      ['--verify', '--deep', '--strict', libreOfficePath],
      { stdio: 'inherit' },
    );
    console.log(
      `[after-pack] 内置 LibreOffice ad-hoc 签名校验通过：${libreOfficePath}`,
    );
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
  console.log(`[after-pack] macOS ad-hoc 签名校验通过：${appPath}`);
}

module.exports = afterPack;
module.exports.findNestedLibreOfficeBundles = findNestedLibreOfficeBundles;
module.exports.copySqlCipherNativeAsset = copySqlCipherNativeAsset;
module.exports.electronBuilderArchName = electronBuilderArchName;
module.exports.MAX_APP_ASAR_BYTES = MAX_APP_ASAR_BYTES;
module.exports.packagedResourcesRoot = packagedResourcesRoot;
module.exports.verifyPackagedPayload = verifyPackagedPayload;
