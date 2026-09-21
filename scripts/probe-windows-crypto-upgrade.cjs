/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
// Load the installed app's modules in the identical pinned Electron version.
// A packaged Otto.exe ignores external entry scripts; do not fake that probe.
// Only synthetic data in a disposable hosted runner is permitted.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function createStageReporter(write) {
  const stages = new Set([
    'admission',
    'electron-host',
    'secure-storage',
    'installed-modules',
    'installed-version',
    'server-scope',
    'device-identity',
    'native-activation',
    'seed-data',
    'seed-receipt',
    'identity-continuity',
    'native-key-inventory',
    'native-group',
    'encrypted-history',
    'pending-outbox',
    'trust-rollback',
    'key-files',
    'history-files',
    'verified-receipt',
    'native-close',
  ]);
  let stage = 'admission';
  return {
    enter(next) {
      if (!stages.has(next)) throw new Error('Invalid probe stage');
      stage = next;
      write(`OTTO_CRYPTO_STAGE ${stage}\n`);
    },
    failed() {
      // Never accept an Error or assertion values as diagnostic output.
      write(`OTTO_CRYPTO_FAILURE ${stage}\n`);
    },
  };
}
const reporter = createStageReporter((line) => fs.writeSync(2, line));

function admittedPaths(env, platform) {
  if (
    platform !== 'win32' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.RUNNER_OS !== 'Windows'
  ) {
    throw new Error(
      'GitHub-hosted Windows runner only; no user installation access',
    );
  }
  if (
    !env.RUNNER_TEMP ||
    !env.GITHUB_WORKSPACE ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
  )
    throw new Error('Missing hosted run identity');
  const root = path.resolve(env.RUNNER_TEMP);
  if (root === path.parse(root).root) throw new Error('Unsafe fixture root');
  return {
    root,
    profile: path.join(root, 'otto-crypto-upgrade-fixture'),
    install: path.join(root, 'otto-packaged-runtime'),
  };
}
function noRedirect(target) {
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new Error('Redirected fixture path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (cursor === path.dirname(cursor)) break;
  }
}
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function files(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    noRedirect(file);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(files(file)))
        result[`${entry.name}/${name}`] = hash;
    } else if (entry.isFile()) result[entry.name] = digest(file);
    else throw new Error('Unexpected fixture file');
  }
  return result;
}

async function main() {
  reporter.enter('admission');
  const { profile, install } = admittedPaths(process.env, process.platform);
  const phase = process.argv[2];
  if (!['seed', 'verify'].includes(phase))
    throw new Error('Invalid probe phase');
  noRedirect(profile);
  noRedirect(install);
  const executable = path.join(install, 'Otto.exe');
  reporter.enter('electron-host');
  const electronHost = path.join(
    path.dirname(require.resolve('electron/package.json')),
    'dist',
    'electron.exe',
  );
  assert.equal(
    path.resolve(process.execPath).toLowerCase(),
    electronHost.toLowerCase(),
    'Probe must use the pinned Electron host',
  );
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1')
    throw new Error('Full Electron runtime required');
  const { app, safeStorage } = require('electron');
  if (phase === 'seed') fs.mkdirSync(profile, { recursive: false });
  else assert(fs.statSync(profile).isDirectory(), 'Missing historical fixture');
  app.setPath('userData', profile);
  await app.whenReady();
  reporter.enter('secure-storage');
  assert(
    safeStorage.isEncryptionAvailable(),
    'OS secure storage is unavailable',
  );
  const secureStorage = {
    assertAvailable() {
      assert(safeStorage.isEncryptionAvailable());
    },
    protect(value) {
      return safeStorage.encryptString(value).toString('base64');
    },
    unprotect(value) {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    },
  };
  const archive = path.join(install, 'resources', 'app.asar');
  reporter.enter('installed-modules');
  const load = (name) => require(path.join(archive, 'dist', 'main', name));
  const { EnterpriseE2eeCrypto, EnterpriseE2eeKeyVault } =
    load('enterprise-e2ee.js');
  const { EnterpriseMlsSessionManager } = load('enterprise-mls.js');
  const { FileEnterpriseMlsMessageHistory } = load(
    'enterprise-mls-private-messages.js',
  );
  const metadata = require(path.join(archive, 'package.json'));
  const version = metadata.version;
  reporter.enter('installed-version');
  const runtime = spawnSync(executable, ['-p', 'process.versions.electron'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(runtime.status, 0, 'Installed runtime version probe failed');
  assert.equal(
    process.versions.electron,
    runtime.stdout.trim(),
    'Installed app and probe Electron versions differ',
  );
  if (phase === 'seed') assert.equal(version, '1.9.14');
  else assert.equal(version, process.argv[3], 'Candidate version mismatch');
  const vaultDirectory = path.join(profile, 'keys');
  const historyDirectory = path.join(profile, 'history');
  const e2ee = new EnterpriseE2eeCrypto(
    new EnterpriseE2eeKeyVault({ directory: vaultDirectory, ...secureStorage }),
  );
  const oldUrl = 'https://59.110.154.44:7777';
  const newUrl = 'https://101.200.190.204:7777';
  reporter.enter('server-scope');
  const serverScope =
    phase === 'seed'
      ? oldUrl
      : e2ee.resolveServerScope(newUrl, 'fixture-alice');
  assert.equal(serverScope, oldUrl, 'Cryptographic namespace changed');
  reporter.enter('device-identity');
  const device = e2ee.localDevice(serverScope, 'fixture-alice');
  const scope = {
    serverUrl: serverScope,
    organizationId: 'fixture-org',
    accountId: 'fixture-alice',
    deviceId: device.deviceId,
  };
  const history = new FileEnterpriseMlsMessageHistory({
    directory: historyDirectory,
    secureStorage,
  });
  const mls = new EnterpriseMlsSessionManager({
    stateDirectory: path.join(profile, 'mls'),
    secureStorage,
    binaryPath: path.join(
      install,
      'resources',
      'otto-native',
      'win32-x64',
      'otto-native.exe',
    ),
  });
  const receiptPath = path.join(profile, 'seed.json');
  const expectedContent = 'Synthetic upgrade continuity message';
  try {
    reporter.enter('native-activation');
    await mls.activate({ ...scope, approvalState: 'approved' });
    if (phase === 'seed') {
      reporter.enter('seed-data');
      const keyPackage = await mls.createKeyPackage();
      const group = await mls.createGroup('fixture-bob');
      const message = {
        id: 'mls-message-018f0000-0000-7000-8000-000000000001',
        senderAccountId: 'fixture-alice',
        recipientAccountId: 'fixture-bob',
        content: expectedContent,
        contentType: 'message',
        inReplyToMessageId: null,
        createdAt: '2026-09-01T00:00:00Z',
        readAt: null,
        attachments: [],
        attachmentManifests: [],
        deliveryState: 'pending',
        e2ee: true,
        e2eeProtocol: 'mls10-openmls-0.8',
      };
      await history.put(scope, 'fixture-bob', message);
      // Non-empty pin: a recovered server must not silently reset trust history.
      const entry = {
        sequence: 1,
        organizationId: scope.organizationId,
        accountId: scope.accountId,
        deviceId: device.deviceId,
        event: 'bootstrap_approved',
        keyFingerprint: device.keyFingerprint,
        actorDeviceId: null,
        previousHash: '0'.repeat(64),
        createdAt: '2026-09-01T00:00:00Z',
      };
      const entryHash = createHash('sha256')
        .update('otto:e2ee-key-transparency:v1\n')
        .update(JSON.stringify(entry))
        .digest('hex');
      e2ee.verifyAndPinKeyTransparency({
        serverScope,
        organizationId: scope.organizationId,
        view: {
          accountId: scope.accountId,
          headSequence: 1,
          headHash: entryHash,
          entries: [{ ...entry, entryHash }],
        },
      });
      await mls.close();
      reporter.enter('seed-receipt');
      const receipt = {
        source: process.env.GITHUB_SHA,
        version,
        deviceId: device.deviceId,
        fingerprint: device.keyFingerprint,
        keyReference: keyPackage.reference,
        group,
        keys: files(vaultDirectory),
        history: files(historyDirectory),
      };
      fs.writeFileSync(receiptPath, JSON.stringify(receipt), { flag: 'wx' });
    } else {
      reporter.enter('identity-continuity');
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      assert.equal(receipt.source, process.env.GITHUB_SHA);
      assert.equal(device.deviceId, receipt.deviceId);
      assert.equal(device.keyFingerprint, receipt.fingerprint);
      reporter.enter('native-key-inventory');
      assert(
        (await mls.listKeyPackages()).some(
          (key) => key.reference === receipt.keyReference,
        ),
        'MLS private key inventory was lost',
      );
      reporter.enter('native-group');
      const group = await mls.inspectGroup('fixture-bob');
      assert.equal(group.group_id, receipt.group.group_id);
      assert.equal(group.epoch, receipt.group.epoch);
      reporter.enter('encrypted-history');
      assert.equal(
        (await history.list(scope, 'fixture-bob'))[0].content,
        expectedContent,
      );
      reporter.enter('pending-outbox');
      assert.equal(
        (await history.pendingOutgoing(scope, 'fixture-bob')).length,
        1,
      );
      reporter.enter('trust-rollback');
      assert.throws(
        () =>
          e2ee.verifyAndPinKeyTransparency({
            serverScope,
            organizationId: scope.organizationId,
            view: {
              accountId: scope.accountId,
              headSequence: 0,
              headHash: '0'.repeat(64),
              entries: [],
            },
          }),
        /rollback/,
      );
      reporter.enter('key-files');
      assert.deepEqual(
        files(vaultDirectory),
        receipt.keys,
        'Original key files changed',
      );
      reporter.enter('history-files');
      assert.deepEqual(
        files(historyDirectory),
        receipt.history,
        'Original history files changed',
      );
      await mls.close();
      reporter.enter('verified-receipt');
      fs.writeFileSync(
        path.join(profile, 'verified.json'),
        JSON.stringify({
          source: process.env.GITHUB_SHA,
          from: receipt.version,
          to: version,
          passed: true,
          deviceIdentity: true,
          osProtectedKeys: true,
          encryptedHistory: true,
          pendingOutbox: true,
          nativeMlsState: true,
          rollbackRejected: true,
          electronHostVersion: process.versions.electron,
          scope:
            'Installed modules and native binary after real installer upgrade; not UI login or online server data verification',
          executableSha256: digest(executable),
          archiveSha256: digest(archive),
        }),
        { flag: 'wx' },
      );
    }
  } finally {
    await mls.close();
  }
  app.exit(0);
}

module.exports = { admittedPaths, createStageReporter };
// Electron 43's default app dynamically imports its entry; require.main is not
// this module in that path. Still keep ordinary helper imports side-effect free.
if (
  require.main === module ||
  (process.versions.electron &&
    process.argv[1] &&
    path.resolve(process.argv[1]) === __filename)
)
  main().catch((error) => {
    reporter.failed();
    // Preserve the fixed admission explanation, not arbitrary assertion dumps.
    if (
      error.message ===
      'GitHub-hosted Windows runner only; no user installation access'
    ) {
      fs.writeSync(2, `${error.message}\n`);
    }
    process.exit(1);
  });
