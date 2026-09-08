#!/usr/bin/env node
// Deliberately single-purpose, offline and unsigned. Not a general release builder.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = 'fa3f98a1fdc0bddc6aa48a6ecf1bd13bd8300f69';
const ORGANIZATION = '086d1f17447da13c9c018734ca5b2b05f49fd0a0';
const SEVEN = '8dbd341cb53adc0659708c9dc1b53ce0359e71ed';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ARCHIVE_NAME = 'otto-enterprise-oneclick-v1.9.14-675813a4649b-208cebb4e149.tar.gz';
const PREFIX = ARCHIVE_NAME.slice(0, -7);
const ARCHIVE = `D:/otto/artifacts/v1.9.14-enterprise-fa3f/${ARCHIVE_NAME}`;
const OUTPUT = 'D:/otto/artifacts/rollback-baseline-1.9.14-verified-seven';
const ARCHIVE_SHA = '7425361092e933b8194c628f43b6bf677b4b36a6e0a16d42045cc15ca4c74f55';
const MANIFEST_SHA = '9dbae2ea3e8f4dcb11f93bb36a579d0f4ab5f18f7af3a2fcd93ade1b66fc3389';
const BASE_INPUT_SHA = '208cebb4e149c4a63a0cf305c22b80abc3fc0e476dabff64dcf007fc79f9fbd5';
const STRICT_SHA = 'ad191e776981da91b82fc7849c17553c60d5b493c8c369bbf5f3d4e764e10235';
const KEY_ID = '74def647c0970a16';
const SIGNATURE = 'z7MLP52BSi_qgOZqzovKOSW72Oc2qvpqh68vhB-ixKm7XAauTkDs-O60wIqYfR-4e1qw8genwA3JVFyC9z9qBw';
const ENVELOPE_SHA = 'dbb5d4d684015ec6b0441c0573c8f93c643c02c0242aa64121b4f34fcaedf3be';
const GRANTS = 'enterprise_tree,park_service,feishu_auto_reply,direct_messages,atoa,knowledge,skill_market';
const RECIPE_FILES = ['recovery/README.md', 'recovery/checkpoint.test.mjs', 'recovery/legacy-signing-public.pem', 'recovery/reconstruct-checkpoint.mjs', 'recovery/strict-verify-release.mjs'];
// The six historical archive outputs plus the preceding organization hotfix.
// authorizationComposition.js is intentionally byte-identical to the base.
const PATCHES = [
  ['src/enterprise/db.js', '4f33270995fbbd882cfd53da022bc10cf1aaf509', '1881f1ba906b63db1a755e55c2d9148479ba6cb07260ebf96c4217cba1dbd6a7', 'typescript', SEVEN],
  ['src/modules/authorization/authorizationComposition.js', '27d47deb553d03257222fceea8c3b1d9ec1c190e', '9f5e09e92ddcf0f59ef2289b849819eeaa61dd2afe4605875f8a421b7b9200f5', 'typescript', SEVEN],
  ['src/modules/authorization/organizationFeatureAccess.js', '304ea848057564c1bb3c30c1364d261527b173a0', '10f589fc5e1d086ee085524304f4a5c093290046a2cb400c69d1176c1d8fa177', 'esbuild', ORGANIZATION],
  ['src/modules/commercial_control/commercialControlComposition.js', '42f663fe9ac80f6b69f9ee22899a52626df7d9e5', '92a8a4590095bf5e3a16965a23cf93ed8976175abc4ac5e59c8f9a56347027d2', 'typescript', SEVEN],
  ['src/modules/commercial_control/deploymentFeatureGrants.js', 'b1eafc9158b25ab0b1f1072222873a7257fbd02e', '714efef23b10ac3304699d2199caaf32c30406923765b1f45934f87273489d9c', 'typescript', SEVEN],
  ['src/modules/commercial_control/deploymentRepository.js', '87e912ee18f578cab9e80a5ea69ba1ba2524b42e', 'af36fcdaa96437ccdae6938d61110bf025e46b9e7d753a23c85b56d9353bd6de', 'typescript', SEVEN],
  ['src/modules/commercial_control/index.js', '81b191a77b3f432f73981aa510e52cbbe64b1353', '459e02ce08ef8ef0f85251ad815f4ca2c8f4971e2ed69f48efa0028424d55f3f', 'typescript', SEVEN],
].map(([output, blob, sha256, compiler, sourceCommit]) => ({ output, source: `packages/server/${output.replace(/\.js$/, '.ts')}`, blob, sha256, compiler, sourceCommit }));
const TESTS = [
  ['packages/server/src/identityOrganizationFeatures.test.ts', 'f28e6933bebfb237f6a87923f446749cf7747bee'],
  ['packages/server/src/modules/commercial_control/deploymentFeatureGrants.test.ts', '6558a042f87ded91c46902d549e50ac8cade959d'],
  ['packages/server/src/modules/commercial_control/deploymentRepository.test.ts', '8e4a5e456ade92d2a938c1faa2e403bef776bcf0'],
];

const digest = (input, algorithm = 'sha256') => createHash(algorithm).update(input).digest('hex');
export function verifyDigest(input, expected, label) {
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(digest(input), expected, `${label}: SHA-256 mismatch`);
}
export function safeRelative(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/);
  assert.ok(!value.split('/').some((part) => part === '.' || part === '..'));
  return value;
}
export function assertExactSet(actual, expected, label) {
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicates`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label}: exact file scope mismatch`);
}
export function contentIdentity(files, algorithm = 'sha1') {
  return digest(Object.keys(files).sort().map((file) => `${file}\0${files[file]}\n`).join(''), algorithm);
}
function git(args) {
  return execFileSync('git', ['-C', ROOT, '-c', `safe.directory=${ROOT.replaceAll('\\', '/')}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'file' }, maxBuffer: 32 * 1024 * 1024,
  });
}
function gitText(args) { return git(args).toString().trim(); }
function archiveMember(relative) {
  return execFileSync('tar', ['-xOzf', ARCHIVE, `${PREFIX}/${safeRelative(relative)}`], { maxBuffer: 32 * 1024 * 1024 });
}
function listFiles(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    assert.ok(!entry.isSymbolicLink(), `link forbidden: ${absolute}`);
    if (entry.isDirectory()) result.push(...listFiles(root, absolute));
    else { assert.ok(entry.isFile(), `non-file forbidden: ${absolute}`); result.push(path.relative(root, absolute).replaceAll('\\', '/')); }
  }
  return result.sort();
}
function writeNew(root, relative, content) {
  const destination = path.join(root, safeRelative(relative));
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content, { flag: 'wx' });
}
function verifyTree(root, manifest) {
  assertExactSet(listFiles(root).filter((file) => file !== 'manifest.json'), Object.keys(manifest.files), 'runtime');
  for (const [relative, sha] of Object.entries(manifest.files)) verifyDigest(readFileSync(path.join(root, safeRelative(relative))), sha, relative);
  assert.equal(contentIdentity(manifest.files), manifest.buildCommit, 'content-derived identity mismatch');
}
function strictVerify(root, expectedOk = true) {
  const checker = path.join(HERE, 'strict-verify-release.mjs');
  verifyDigest(readFileSync(checker), STRICT_SHA, 'strict verifier');
  const result = spawnSync(process.execPath, [checker, root], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (expectedOk) assert.equal(result.status, 0, result.stderr || result.error?.message);
  else assert.notEqual(result.status, 0, 'strict verifier accepted tampering');
  return expectedOk ? JSON.parse(result.stdout) : result.stderr;
}
function assertNoLinksTo(root) {
  let current = path.resolve(root);
  for (;;) {
    if (existsSync(current)) assert.ok(!lstatSync(current).isSymbolicLink(), `ancestor link forbidden: ${current}`);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function sourceInputs(baseInputBytes, releaseRoot, sourceCommit, envelopeBytes) {
  const legacy = baseInputBytes.toString().trim().split(/\r?\n/).map((line) => {
    const parsed = /^([a-f0-9]{64})  (.+)$/.exec(line); assert.ok(parsed, 'invalid historical source inventory');
    return { sha256: parsed[1], legacyPath: parsed[2], file: safeRelative(parsed[2].replaceAll('\\', '/')) };
  });
  assert.equal(legacy.length, 703);
  assert.equal(contentIdentity(Object.fromEntries(legacy.map((entry) => [entry.legacyPath, entry.sha256])), 'sha256'), BASE_INPUT_SHA);
  const altered = new Set([...PATCHES.map((p) => p.source), ...TESTS.map(([p]) => p)]);
  const inputs = {};
  for (const { file, sha256 } of legacy) {
    let bytes;
    if (file.startsWith('native/sqlcipher-node/')) {
      bytes = readFileSync(path.join(releaseRoot, 'native/sqlcipher', file.slice('native/sqlcipher-node/'.length)));
      verifyDigest(bytes, sha256, `preserved native input ${file}`);
    } else {
      bytes = git(['show', `${sourceCommit}:${file}`]);
      assert.ok(readFileSync(path.join(ROOT, file)).equals(bytes), `working source differs from commit: ${file}`);
      if (!altered.has(file)) verifyDigest(bytes, sha256, `unchanged source ${file}`);
    }
    inputs[file] = digest(bytes);
  }
  for (const file of [...altered, ...RECIPE_FILES]) {
    const bytes = git(['show', `${sourceCommit}:${file}`]);
    assert.ok(readFileSync(path.join(ROOT, file)).equals(bytes), `working source differs from commit: ${file}`);
    inputs[file] = digest(bytes);
  }
  // External immutable inputs are explicit; native assets keep base provenance.
  inputs['external/base-archive.tar.gz'] = ARCHIVE_SHA;
  inputs['external/base-signature.json'] = digest(envelopeBytes);
  inputs['external/base-source-inputs.sha256'] = digest(baseInputBytes);
  return inputs;
}

export function build() {
  assert.equal(ROOT.replaceAll('\\', '/'), 'D:/otto/otto-rollback-baseline-1.9.14', 'unapproved source directory');
  assertNoLinksTo(ROOT); assertNoLinksTo(OUTPUT);
  assert.equal(gitText(['branch', '--show-current']), 'rollback/1.9.14-verified-seven-feature-checkpoint');
  const sourceCommit = gitText(['rev-parse', 'HEAD']);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(gitText(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' '), [sourceCommit, BASE], 'must be a single reviewed commit directly on base');
  assert.equal(gitText(['status', '--porcelain', '--untracked-files=all']), '', 'source tree must be clean');
  const changed = gitText(['diff-tree', '--no-commit-id', '--name-only', '-r', BASE, sourceCommit]).split('\n');
  assertExactSet(changed, [...PATCHES.map((p) => p.source), ...TESTS.map(([p]) => p), ...RECIPE_FILES], 'composite source delta');
  for (const { source, blob, sourceCommit: origin } of PATCHES) {
    assert.equal(gitText(['rev-parse', `${origin}:${source}`]), blob, 'historical source object mismatch');
    assert.equal(gitText(['rev-parse', `HEAD:${source}`]), blob, 'unauthorized source change');
  }
  for (const [source, blob] of TESTS) assert.equal(gitText(['rev-parse', `HEAD:${source}`]), blob, 'test source changed');
  const archiveBytes = readFileSync(ARCHIVE); verifyDigest(archiveBytes, ARCHIVE_SHA, 'original archive');
  const envelopeBytes = readFileSync(`${ARCHIVE}.sig`), envelope = JSON.parse(envelopeBytes);
  verifyDigest(envelopeBytes, ENVELOPE_SHA, 'original signature envelope');
  assert.equal(envelope.format, 'otto-enterprise-package-signature-v1'); assert.equal(envelope.algorithm, 'Ed25519');
  assert.equal(envelope.file, ARCHIVE_NAME); assert.equal(envelope.sha256, ARCHIVE_SHA);
  assert.equal(envelope.keyId, KEY_ID); assert.equal(envelope.signature, SIGNATURE);
  const publicBytes = readFileSync(path.join(HERE, 'legacy-signing-public.pem'));
  const publicKey = createPublicKey(publicBytes);
  assert.equal(digest(publicKey.export({ format: 'der', type: 'spki' })).slice(0, 16), KEY_ID);
  assert.ok(verify(null, archiveBytes, publicKey, Buffer.from(SIGNATURE, 'base64url')), 'original Ed25519 signature rejected');
  const originalManifestBytes = archiveMember('release/manifest.json'); verifyDigest(originalManifestBytes, MANIFEST_SHA, 'original manifest');
  const originalManifest = JSON.parse(originalManifestBytes);
  assert.equal(originalManifest.sourceCommit, BASE); assert.equal(originalManifest.sourceInputSha256, BASE_INPUT_SHA);
  assert.equal(originalManifest.buildCommit, '675813a4649be29a0c182f4adf267c7f7ab356da');
  assert.equal(originalManifest.version, '1.9.14'); assert.equal(Object.keys(originalManifest.files).length, 7654);
  const members = execFileSync('tar', ['-tzf', ARCHIVE], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split(/\r?\n/);
  for (const member of members) { assert.ok(member.startsWith(`${PREFIX}/`)); if (member !== `${PREFIX}/`) safeRelative(member.replace(/\/$/, '')); }
  assert.equal(new Set(members).size, members.length, 'archive duplicate members');
  const runtimeMembers = members.filter((member) => member.startsWith(`${PREFIX}/release/`) && !member.endsWith('/')).map((member) => member.slice(`${PREFIX}/release/`.length));
  assertExactSet(runtimeMembers, ['manifest.json', ...Object.keys(originalManifest.files)], 'signed archive runtime');
  mkdirSync(OUTPUT, { recursive: true });
  const staging = path.join(OUTPUT, `.construct-${process.pid}`);
  assert.ok(!existsSync(staging), 'staging already exists'); mkdirSync(staging);
  execFileSync('tar', ['-xzf', ARCHIVE, '-C', staging, `${PREFIX}/release`], { maxBuffer: 1024 * 1024 });
  const releaseRoot = path.join(staging, PREFIX, 'release');
  verifyTree(releaseRoot, originalManifest); strictVerify(releaseRoot);
  const baseInputBytes = archiveMember('SOURCE-INPUTS.sha256');
  const inputs = sourceInputs(baseInputBytes, releaseRoot, sourceCommit, envelopeBytes);
  const sourceInputSha256 = contentIdentity(inputs, 'sha256');
  const toolRequire = createRequire('D:/otto/otto-release-1.9.15-candidate/package.json');
  const ts = toolRequire('typescript'), esbuild = toolRequire('esbuild');
  assert.equal(ts.version, '5.9.3'); assert.equal(esbuild.version, '0.25.12');
  const outputs = [];
  for (const patch of PATCHES) {
    const input = git(['show', `HEAD:${patch.source}`]).toString();
    const compiled = patch.compiler === 'typescript'
      ? ts.transpileModule(input, { fileName: path.basename(patch.source), compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, sourceMap: true } }).outputText
      : esbuild.transformSync(input, { loader: 'ts', format: 'esm', target: 'node22' }).code;
    verifyDigest(compiled, patch.sha256, `reproduced ${patch.output}`);
    const destination = path.join(releaseRoot, patch.output);
    if (existsSync(destination)) assert.ok(lstatSync(destination).isFile() && !lstatSync(destination).isSymbolicLink());
    writeFileSync(destination, compiled);
    outputs.push({ ...patch, originalSha256: originalManifest.files[patch.output] ?? null, sourceSha256: digest(input) });
  }
  const reconstruction = {
    format: 'otto-verified-seven-feature-checkpoint-v1', purpose: 'independent unsigned rollback checkpoint; not a reissue of the original 1.9.14 release',
    compositeSourceCommit: sourceCommit, sourceInputSha256,
    sourceInputAlgorithm: 'SHA256 of sorted portable-path + NUL + lowercase SHA256 + LF; tracked original 703-input scope, two added tests/source files, five recipe files and three immutable external inputs; native inputs inherited unchanged',
    base: { sourceCommit: BASE, buildCommit: originalManifest.buildCommit, archive: ARCHIVE_NAME, archiveSha256: ARCHIVE_SHA, manifestSha256: MANIFEST_SHA, sourceInputSha256: BASE_INPUT_SHA, signingKeyId: KEY_ID, signatureVerified: true, runtimeFilesVerified: 7654 },
    patchSources: [ORGANIZATION, SEVEN], outputs,
    compilers: { typescript: '5.9.3', typescriptOptions: { target: 'ES2022', module: 'ES2022', sourceMap: true, fileName: 'source basename' }, esbuild: '0.25.12', esbuildOptions: { loader: 'ts', format: 'esm', target: 'node22' }, executionNode: process.version },
    nativeProvenance: { inheritedFromSignedArchive: true, sourceCommit: BASE, rebuilt: false, relabeled: false },
    untouchedRuntimePolicy: 'all original file bytes retained except the seven allowlisted outputs; original debug/source-map files are retained, not regenerated',
    strictVerifierSha256: STRICT_SHA,
    requiredActivation: { administratorSignaturePending: true, productionMutationPerformed: false, preserveOriginalReleaseAndManifest: true, OTTO_ENTERPRISE_DEPLOYMENT_GRANTS: GRANTS, OTTO_BUILD_COMMIT: 'set to the newly derived manifest.buildCommit, never to patch source commit', otherEnvironment: 'preserve existing identity, tenant, keys and data; administrator must bind a redacted environment receipt before activation' },
  };
  const metadata = {
    'RECONSTRUCTION.json': `${JSON.stringify(reconstruction, null, 2)}\n`,
    'reconstruction/base-manifest.json': originalManifestBytes,
    'reconstruction/base-source-inputs.sha256': baseInputBytes,
    'reconstruction/base-package-signature.json': envelopeBytes,
    'reconstruction/legacy-signing-public.pem': publicBytes,
    'reconstruction/recipe.mjs': readFileSync(path.join(HERE, 'reconstruct-checkpoint.mjs')),
    'reconstruction/recipe.test.mjs': readFileSync(path.join(HERE, 'checkpoint.test.mjs')),
    'reconstruction/strict-verify-release.mjs': readFileSync(path.join(HERE, 'strict-verify-release.mjs')),
    'reconstruction/source-inputs.sha256': `${Object.keys(inputs).sort().map((file) => `${inputs[file]}  ${file}`).join('\n')}\n`,
  };
  for (const [relative, bytes] of Object.entries(metadata)) writeNew(releaseRoot, relative, bytes);
  const expectedFiles = [...new Set([...Object.keys(originalManifest.files), ...PATCHES.map((p) => p.output), ...Object.keys(metadata)])];
  assertExactSet(listFiles(releaseRoot).filter((p) => p !== 'manifest.json'), expectedFiles, 'constructed runtime');
  const files = Object.fromEntries(expectedFiles.sort().map((file) => [file, digest(readFileSync(path.join(releaseRoot, file)))]));
  for (const [file, expected] of Object.entries(originalManifest.files)) if (!PATCHES.some((p) => p.output === file)) assert.equal(files[file], expected, `non-patch runtime changed: ${file}`);
  const buildCommit = contentIdentity(files);
  const manifest = { ...originalManifest, buildCommit, sourceCommit, sourceTreeDirty: false, sourceDiffSha256: EMPTY, sourceInputSha256, builtAt: new Date().toISOString(), files, reconstruction: { format: reconstruction.format, record: 'RECONSTRUCTION.json', baseArchiveSha256: ARCHIVE_SHA, baseManifestSha256: MANIFEST_SHA } };
  writeFileSync(path.join(releaseRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyTree(releaseRoot, manifest); const verification = strictVerify(releaseRoot);
  // Exercise the actual strict verifier on the complete constructed tree, restoring
  // only our own new metadata each time. Never touches the base archive or production.
  const tamperPath = path.join(releaseRoot, 'RECONSTRUCTION.json'); const before = readFileSync(tamperPath);
  try { writeFileSync(tamperPath, Buffer.concat([before, Buffer.from('tamper')])); strictVerify(releaseRoot, false); }
  finally { writeFileSync(tamperPath, before); }
  const manifestPath = path.join(releaseRoot, 'manifest.json'); const manifestBefore = readFileSync(manifestPath);
  try { writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, sourceTreeDirty: true })}\n`); strictVerify(releaseRoot, false); }
  finally { writeFileSync(manifestPath, manifestBefore); }
  verifyTree(releaseRoot, manifest); strictVerify(releaseRoot);
  const finalRoot = path.join(OUTPUT, `1.9.14-${buildCommit.slice(0, 12)}`);
  assert.ok(!existsSync(finalRoot), 'refuse to overwrite an existing checkpoint'); renameSync(releaseRoot, finalRoot);
  const receipt = { releaseRoot: finalRoot, sourceCommit, buildCommit, sourceInputSha256, manifestSha256: digest(readFileSync(path.join(finalRoot, 'manifest.json'))), reconstructionSha256: files['RECONSTRUCTION.json'], fileCount: expectedFiles.length, signatureStatus: 'UNSIGNED_PENDING_ADMINISTRATOR', verification, negativeTests: ['runtime metadata byte tamper rejected', 'dirty-source manifest rejected'], originalArchiveUnchanged: digest(readFileSync(ARCHIVE)) === ARCHIVE_SHA };
  writeNew(OUTPUT, `${path.basename(finalRoot)}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2)); return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['build'], 'usage: node recovery/reconstruct-checkpoint.mjs build (fixed inputs, no override flags)');
  build();
}
