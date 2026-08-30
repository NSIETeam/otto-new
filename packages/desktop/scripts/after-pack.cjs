/**
 * electron-builder 打包后钩子。
 *
 * 公开测试渠道暂未使用 Apple Developer ID；electron-builder 在 identity:null
 * 时只留下 linker 签名，资源没有封存，经过下载隔离后容易被 Gatekeeper 判成
 * “App 已损坏”。这里为 macOS bundle 补完整的深度 ad-hoc 签名并立即严格校验。
 * 它不能替代 Apple 公证，但能确保 DMG 中的 App 自身结构和资源封存有效。
 */

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

function electronBuilderArchName(value) {
  if (value === 'x64' || value === 1) return 'x64';
  if (value === 'arm64' || value === 3) return 'arm64';
  throw new Error(`[after-pack] unsupported SQLCipher architecture: ${value}`);
}

function findOpenSslRuntimeLibrary(env = process.env) {
  const candidates = [
    env.OTTO_OPENSSL_RUNTIME_DIR
      ? path.join(env.OTTO_OPENSSL_RUNTIME_DIR, 'libcrypto.3.dylib')
      : null,
    '/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib',
    '/usr/local/opt/openssl@3/lib/libcrypto.3.dylib',
  ].filter(Boolean);
  return candidates.find(existsSync) ?? null;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function updatePackagedSqlCipherMetadata(directory) {
  const bindingPath = path.join(directory, 'better_sqlite3.node');
  const manifestPath = path.join(directory, 'manifest.json');
  const sbomPath = path.join(directory, 'sbom.cdx.json');
  const bindingSha256 = sha256File(bindingPath);
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
  const component = sbom.metadata?.component?.name === 'better_sqlite3.node'
    ? sbom.metadata.component
    : sbom.components?.find((item) => item.name === 'better_sqlite3.node');
  const hash = component?.hashes?.find((item) => item.alg === 'SHA-256');
  if (!hash) throw new Error('[after-pack] SQLCipher SBOM binding hash is missing');
  hash.content = bindingSha256;
  writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.sha256 = bindingSha256;
  manifest.sbom.sha256 = sha256File(sbomPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
  const resourcesRoot =
    platform === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');
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
  if (platform === 'darwin') {
    const openSslRuntime = findOpenSslRuntimeLibrary();
    if (!openSslRuntime) {
      throw new Error(
        '[after-pack] OpenSSL 3 runtime is required to make SQLCipher portable; '
        + 'install openssl@3 or set OTTO_OPENSSL_RUNTIME_DIR',
      );
    }
    const packagedRuntime = path.join(destination, 'libcrypto.3.dylib');
    const packagedBinding = path.join(destination, 'better_sqlite3.node');
    copyFileSync(openSslRuntime, packagedRuntime);
    execFileSync(
      'install_name_tool',
      [
        '-change',
        '/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib',
        '@loader_path/libcrypto.3.dylib',
        packagedBinding,
      ],
      { stdio: 'inherit' },
    );
    updatePackagedSqlCipherMetadata(destination);
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
module.exports.findOpenSslRuntimeLibrary = findOpenSslRuntimeLibrary;
module.exports.updatePackagedSqlCipherMetadata = updatePackagedSqlCipherMetadata;
