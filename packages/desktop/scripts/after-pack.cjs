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
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const MAX_APP_ASAR_BYTES = 120 * 1024 * 1024;
const SQLCIPHER_RESOURCE_FILES = Object.freeze([
  'better_sqlite3.node',
  'manifest.json',
  'sbom.cdx.json',
  'THIRD_PARTY_NOTICES.md',
]);
const OTTO_NATIVE_RESOURCE_FILES = Object.freeze(['manifest.json']);

function electronBuilderArchName(value) {
  if (value === 'x64' || value === 1) return 'x64';
  if (value === 'arm64' || value === 3) return 'arm64';
  throw new Error(`[after-pack] unsupported architecture: ${value}`);
}

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
  const archivePath = path.join(packagedResourcesRoot(context), 'app.asar');
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, 'verify-packaged-content.mjs'),
      archivePath,
      '--max-bytes',
      String(MAX_APP_ASAR_BYTES),
    ],
    { stdio: 'inherit' },
  );
}

function verifyPackagedRipgrep(context) {
  const platform = context.electronPlatformName;
  if (!['win32', 'darwin'].includes(platform)) return;
  const arch = electronBuilderArchName(context.arch);
  const executableName = platform === 'win32' ? 'rg.exe' : 'rg';
  const executablePath = path.join(
    packagedResourcesRoot(context),
    'ripgrep',
    executableName,
  );
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, 'ripgrep-runtime.mjs'),
      executablePath,
      '--platform',
      platform,
      '--arch',
      arch,
      '--require-source-digest',
    ],
    { stdio: 'inherit' },
  );
  console.log(`[after-pack] ripgrep source verified: ${platform}-${arch}`);
}

function packagedArchivePath(context) {
  return path.join(packagedResourcesRoot(context), 'app.asar');
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
  for (const name of SQLCIPHER_RESOURCE_FILES) {
    const sourcePath = path.join(sourceRoot, target, name);
    const destinationPath = path.join(destination, name);
    copyFileSync(sourcePath, destinationPath);
    if (fileSha256(sourcePath) !== fileSha256(destinationPath)) {
      throw new Error(
        `[after-pack] copied SQLCipher asset digest mismatch: ${name}`,
      );
    }
  }
  console.log(
    `[after-pack] SQLCipher native asset copied with exact source identity: ${target}`,
  );
}

function copyOttoNativeAsset(context) {
  const platform = context.electronPlatformName;
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error(
      `[after-pack] unsupported Otto native platform: ${platform}`,
    );
  }
  const arch = electronBuilderArchName(context.arch);
  const target = `${platform}-${arch}`;
  const binaryName = platform === 'win32' ? 'otto-native.exe' : 'otto-native';
  const repoRoot = path.resolve(__dirname, '../../..');
  const sourceRoot = path.join(repoRoot, 'native', 'otto-native');
  const verifyArguments = [
    path.join(repoRoot, 'scripts', 'otto-native-runtime.mjs'),
    'verify',
    '--root',
    sourceRoot,
    '--target',
    target,
  ];
  if (process.env.GITHUB_SHA) {
    verifyArguments.push('--expected-build-commit', process.env.GITHUB_SHA);
  }
  execFileSync(process.execPath, verifyArguments, { stdio: 'inherit' });

  const destination = path.join(
    packagedResourcesRoot(context),
    'otto-native',
    target,
  );
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of [...OTTO_NATIVE_RESOURCE_FILES, binaryName]) {
    copyFileSync(
      path.join(sourceRoot, target, name),
      path.join(destination, name),
    );
  }
  if (platform !== 'win32') {
    chmodSync(path.join(destination, binaryName), 0o755);
  }

  const packagedVerifyArguments = [
    path.join(__dirname, 'verify-packaged-otto-native.mjs'),
    packagedArchivePath(context),
    '--platform',
    platform,
    '--arch',
    arch,
  ];
  if (process.env.GITHUB_SHA) {
    packagedVerifyArguments.push(
      '--expected-build-commit',
      process.env.GITHUB_SHA,
    );
  }
  execFileSync(process.execPath, packagedVerifyArguments, {
    stdio: 'inherit',
  });
  console.log(`[after-pack] Otto native runtime copied: ${target}`);
  return {
    arch,
    binaryPath: path.join(destination, binaryName),
    manifestPath: path.join(destination, 'manifest.json'),
    platform,
    target,
  };
}

function fileSha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function finalizePackagedOttoNativeAsset(asset, signature) {
  if (
    !signature ||
    !['authenticode', 'codesign'].includes(signature.kind) ||
    typeof signature.verified !== 'boolean'
  ) {
    throw new Error('[after-pack] invalid packaged native signature identity');
  }
  const manifest = JSON.parse(readFileSync(asset.manifestPath, 'utf8'));
  manifest.packaged = {
    size: statSync(asset.binaryPath).size,
    sha256: fileSha256(asset.binaryPath),
    signature,
  };
  writeFileSync(
    asset.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function verifyFinalPackagedOttoNativeAsset(context, asset) {
  const verifyArguments = [
    path.join(__dirname, 'verify-packaged-otto-native.mjs'),
    packagedArchivePath(context),
    '--platform',
    asset.platform,
    '--arch',
    asset.arch,
    '--packaged',
  ];
  if (process.env.GITHUB_SHA) {
    verifyArguments.push('--expected-build-commit', process.env.GITHUB_SHA);
  }
  if (asset.platform === 'darwin') {
    verifyArguments.push('--require-code-signature');
  }
  execFileSync(process.execPath, verifyArguments, { stdio: 'inherit' });
}

function verifyCodeSignature(target, deep = false) {
  const args = ['--verify'];
  if (deep) args.push('--deep');
  args.push('--strict', '--verbose=2', target);
  execFileSync('codesign', args, { stdio: 'inherit' });
}

function codeSign(target, { identity, keychainFile, deep = false }) {
  const signer = identity?.hash || identity?.name || '-';
  const args = ['--force'];
  if (deep) args.push('--deep');
  args.push('--sign', signer);
  if (keychainFile) args.push('--keychain', keychainFile);
  if (identity) {
    args.push('--options', 'runtime', '--timestamp');
  } else {
    args.push('--timestamp=none');
  }
  args.push(target);
  execFileSync('codesign', args, { stdio: 'inherit' });
}

async function resolveMacSigningIdentity(context) {
  const config =
    context.packager._activePackConfig ??
    context.packager.platformSpecificBuildOptions;
  if (config.identity === null) {
    return { config, identity: null, keychainFile: null };
  }
  const keychainFile = (await context.packager.codeSigningInfo.value)
    .keychainFile;
  const type = config.type || 'distribution';
  const identity = await context.packager.helper.findSigningIdentity(
    false,
    type === 'development',
    config.identity,
    keychainFile,
    config,
  );
  if (!identity) {
    throw new Error(
      '[after-pack] Developer ID identity is unavailable for Otto native runtime',
    );
  }
  return { config, identity, keychainFile };
}

function logMacNativeSignatureChange(asset, beforeSha256) {
  console.log(
    `[after-pack] Otto native codesign digest: ${asset.target} before=${beforeSha256} after=${fileSha256(asset.binaryPath)}`,
  );
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
  verifyPackagedRipgrep(context);
  copySqlCipherNativeAsset(context);
  const ottoNativeAsset = copyOttoNativeAsset(context);
  if (context.electronPlatformName === 'win32') {
    if (typeof context.packager.signIf !== 'function') {
      throw new Error(
        '[after-pack] electron-builder Windows signer is unavailable for Otto native runtime',
      );
    }
    const authenticodeSigned =
      (await context.packager.signIf(ottoNativeAsset.binaryPath)) === true;
    finalizePackagedOttoNativeAsset(ottoNativeAsset, {
      kind: 'authenticode',
      verified: authenticodeSigned,
    });
    verifyFinalPackagedOttoNativeAsset(context, ottoNativeAsset);
  }
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const macSigning = await resolveMacSigningIdentity(context);
  const nativeBeforeSigning = fileSha256(ottoNativeAsset.binaryPath);
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
  if (macSigning.identity) {
    // Sign the external native runtime before electron-builder signs the app.
    // mac.signIgnore keeps this exact Developer ID signature stable while the
    // enclosing app resource seal and notarization are produced.
    codeSign(ottoNativeAsset.binaryPath, macSigning);
    verifyCodeSignature(ottoNativeAsset.binaryPath);
    logMacNativeSignatureChange(ottoNativeAsset, nativeBeforeSigning);
    finalizePackagedOttoNativeAsset(ottoNativeAsset, {
      kind: 'codesign',
      verified: true,
    });
    verifyFinalPackagedOttoNativeAsset(context, ottoNativeAsset);
    return;
  }

  // The explicitly unsigned transition still gets a complete ad-hoc seal.
  // Deep-sign standard nested code first. The Otto native executable lives in
  // a nonstandard Resources subtree, so sign it explicitly before recording
  // its final digest, then re-seal only the outer bundle.
  codeSign(appPath, { identity: null, keychainFile: null, deep: true });
  codeSign(ottoNativeAsset.binaryPath, {
    identity: null,
    keychainFile: null,
  });
  verifyCodeSignature(ottoNativeAsset.binaryPath);
  logMacNativeSignatureChange(ottoNativeAsset, nativeBeforeSigning);
  finalizePackagedOttoNativeAsset(ottoNativeAsset, {
    kind: 'codesign',
    verified: true,
  });
  codeSign(appPath, { identity: null, keychainFile: null });
  verifyFinalPackagedOttoNativeAsset(context, ottoNativeAsset);
  verifyCodeSignature(appPath, true);
  console.log(`[after-pack] macOS ad-hoc 签名校验通过：${appPath}`);
}

module.exports = afterPack;
module.exports.findNestedLibreOfficeBundles = findNestedLibreOfficeBundles;
module.exports.copyOttoNativeAsset = copyOttoNativeAsset;
module.exports.finalizePackagedOttoNativeAsset =
  finalizePackagedOttoNativeAsset;
module.exports.copySqlCipherNativeAsset = copySqlCipherNativeAsset;
module.exports.codeSign = codeSign;
module.exports.electronBuilderArchName = electronBuilderArchName;
module.exports.MAX_APP_ASAR_BYTES = MAX_APP_ASAR_BYTES;
module.exports.OTTO_NATIVE_RESOURCE_FILES = OTTO_NATIVE_RESOURCE_FILES;
module.exports.SQLCIPHER_RESOURCE_FILES = SQLCIPHER_RESOURCE_FILES;
module.exports.packagedArchivePath = packagedArchivePath;
module.exports.packagedResourcesRoot = packagedResourcesRoot;
module.exports.resolveMacSigningIdentity = resolveMacSigningIdentity;
module.exports.verifyPackagedPayload = verifyPackagedPayload;
module.exports.verifyPackagedRipgrep = verifyPackagedRipgrep;
module.exports.verifyFinalPackagedOttoNativeAsset =
  verifyFinalPackagedOttoNativeAsset;
