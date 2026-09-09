#!/usr/bin/env node
// The controller is root; no candidate process runs until systemd owns its cgroup.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runHealthChecks, validateSmsConfiguration } from './health-check.mjs';

const VIEW = '/run/otto-canary';
const UNIT = /^otto-upgrade-canary-[0-9a-f]{32}\.service$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
const reject = (code) => {
  throw new Error(code);
};
const systemEnv = {
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
};
let controlDeadline = Infinity;

function command(binary, args, timeout = 5000, allowNotFound = false) {
  timeout = Math.min(timeout, Math.floor(controlDeadline - performance.now()));
  if (timeout < 1) reject('canary-control-deadline-exceeded');
  try {
    return execFileSync(binary, args, {
      env: systemEnv,
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    if (
      allowNotFound &&
      error.status === 1 &&
      typeof error.stdout === 'string' &&
      /^LoadState=not-found$/m.test(error.stdout)
    )
      return error.stdout.trim();
    reject('canary-control-command-failed');
  }
}
function ordinary(file, { owner = 0, directory = false } = {}) {
  const st = fs.lstatSync(file);
  if (
    st.isSymbolicLink() ||
    (directory ? !st.isDirectory() : !st.isFile()) ||
    st.uid !== owner ||
    (!directory && st.nlink !== 1) ||
    st.mode & 0o022
  )
    reject('canary-path-custody-invalid');
  return st;
}
function json(file, owner = 0) {
  const st = ordinary(file, { owner });
  if (st.size > 1024 * 1024) reject('canary-receipt-too-large');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value, exclusive = true) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, {
    flag: exclusive ? 'wx' : 'w',
    mode: 0o600,
  });
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const directory = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
export function publishControlHandshake(file, nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) reject('canary-handshake-nonce-invalid');
  const staging = `${file}.${randomBytes(16).toString('hex')}.pending`;
  const fd = fs.openSync(staging, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ nonce })}\n`);
    // A root-only file must never become visible under go.json: the worker
    // may read it immediately. Final permissions also must not depend on umask.
    fs.fchmodSync(fd, 0o444);
    fs.fsyncSync(fd);
    // Atomic and no-clobber, including an existing symlink. The nonce reader
    // does not require nlink=1 during this brief publication interval.
    fs.linkSync(staging, file);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(staging);
  }
  const directory = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
export function readinessPublicationComplete(file, owner) {
  let metadata;
  try {
    metadata = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== owner ||
    metadata.mode & 0o022 ||
    ![1, 2].includes(metadata.nlink)
  )
    reject('canary-path-custody-invalid');
  if (metadata.size > 1024 * 1024) reject('canary-receipt-too-large');
  // The producer exclusively links its complete temporary file, then removes
  // that link. Wait inside the original health deadline; never accept nlink=2.
  return metadata.nlink === 1;
}
function transactionRoot(input) {
  if (process.platform !== 'linux' || process.getuid() !== 0)
    reject('canary-requires-linux-root');
  if (
    !input ||
    !path.isAbsolute(input) ||
    !/^\/[A-Za-z0-9_./-]+$/.test(input) ||
    path.resolve(input) !== input ||
    fs.realpathSync(input) !== input
  )
    reject('canary-transaction-path-invalid');
  const st = ordinary(input, { directory: true });
  if ((st.mode & 0o777) !== 0o700 || input === '/' || input === '/tmp')
    reject('canary-transaction-custody-invalid');
  if (fs.statfsSync('/sys/fs/cgroup').type !== 0x63677270)
    reject('canary-requires-cgroup-v2');
  return input;
}

export function buildUnitArguments({
  unit,
  transaction,
  packageRoot,
  nodeRoot,
  uid,
  gid,
}) {
  const properties = [
    'Type=exec',
    `User=${uid}`,
    `Group=${gid}`,
    'SupplementaryGroups=',
    'UMask=0077',
    'MemoryAccounting=yes',
    'MemoryMax=500M',
    'MemorySwapMax=0',
    'CPUAccounting=yes',
    'CPUQuota=50%',
    'TasksMax=64',
    'RuntimeMaxSec=180',
    'TimeoutStopSec=60',
    'KillMode=control-group',
    'Restart=no',
    'OOMPolicy=kill',
    'PrivateNetwork=yes',
    'PrivateIPC=yes',
    'PrivateDevices=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'ProtectProc=invisible',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectControlGroups=yes',
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'RestrictSUIDSGID=yes',
    'RestrictNamespaces=yes',
    'RestrictAddressFamilies=AF_INET AF_INET6',
    'TemporaryFileSystem=/run:ro',
    'TemporaryFileSystem=/tmp:ro',
    'TemporaryFileSystem=/var/tmp:ro',
    `BindReadOnlyPaths=${packageRoot}:${VIEW}/package`,
    `BindReadOnlyPaths=${nodeRoot}/bin/node:${VIEW}/node`,
    `BindReadOnlyPaths=${transaction}/canary/control:${VIEW}/control`,
    `BindPaths=${transaction}/canary/work:${VIEW}/work`,
    `ReadWritePaths=${VIEW}/work`,
    `WorkingDirectory=${VIEW}/work`,
    `LoadCredential=config:${transaction}/canary/config.json`,
    `LoadCredential=database-key:${transaction}/canary/database-key`,
    'StandardInput=null',
    'StandardOutput=null',
    'StandardError=null',
  ];
  return [
    '--quiet',
    '--wait',
    `--unit=${unit}`,
    ...properties.flatMap((p) => ['--property', p]),
    // systemd-run v255 checks argv[0] in the host filesystem before creating
    // the unit. env exists on both sides and execs the bound Node in-place:
    // no shell, no extra supervisor PID, no loss of CREDENTIALS_DIRECTORY.
    '/usr/bin/env',
    '--',
    `${VIEW}/node`,
    `${VIEW}/package/tools/canary-worker.mjs`,
    '_worker',
  ];
}

export function systemdRunDiagnostic(stderr) {
  // Never persist/print raw stderr: the root runner can mention credential
  // source paths. These fixed enums are diagnostic only, never stop proof.
  const bounded = stderr.slice(0, 8192);
  if (/^Failed to find executable /m.test(bounded))
    return 'executable-unavailable';
  if (
    /^Failed to (?:start transient service unit|set unit properties):/m.test(
      bounded,
    )
  )
    return 'unit-start-rejected';
  return 'unclassified';
}

export function runtimeEnvironment(config, credentials, adminToken) {
  return {
    LANG: 'C.UTF-8',
    HOME: `${VIEW}/work`,
    TMPDIR: `${VIEW}/work/tmp`,
    OTTO_ENTERPRISE_DIR: `${VIEW}/work`,
    OTTO_ENTERPRISE_HOST: '127.0.0.1',
    OTTO_ENTERPRISE_PORT: '0',
    OTTO_ENTERPRISE_CANARY_MODE: '1',
    OTTO_ENTERPRISE_READY_FILE: `${VIEW}/work/canary-ready.json`,
    OTTO_ENTERPRISE_ADMIN_TOKEN: adminToken,
    OTTO_ENTERPRISE_PUBLIC_URL: config.publicUrl,
    OTTO_ENTERPRISE_TRUST_PROXY_HOPS: '1',
    OTTO_APP_VERSION: config.version,
    OTTO_BUILD_COMMIT: config.buildId,
    OTTO_ENTERPRISE_DEPLOYMENT_GRANTS: config.deploymentGrants,
    OTTO_LICENSE_TRUST_FILE: `${VIEW}/package/release/license-public-keys.json`,
    OTTO_DATABASE_ENCRYPTION: 'required',
    OTTO_DATABASE_ENCRYPTION_KEY_FILE: `${credentials}/database-key`,
    OTTO_DATABASE_ENCRYPTION_KEY_ID: config.databaseKeyId,
    OTTO_DATABASE_ENCRYPTION_KEY_READONLY: 'true',
    OTTO_SQLCIPHER_NATIVE_BINDING: `${VIEW}/package/release/native/sqlcipher/linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}/better_sqlite3.node`,
    OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE: `${VIEW}/work/account-sync.key`,
    OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE: `${VIEW}/work/attachment-storage.key`,
    OTTO_FIELD_ENCRYPTION_KEY_FILE: `${VIEW}/work/field-encryption.key`,
  };
}

function state(unit) {
  if (!UNIT.test(unit)) reject('canary-unit-invalid');
  const output = command(
    'systemctl',
    [
      'show',
      unit,
      '--property=LoadState,InvocationID,ActiveState,MainPID,ControlGroup,Result,ExecMainCode,ExecMainStatus,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec,TasksMax,PrivateNetwork,PrivateIPC,NoNewPrivileges,CapabilityBoundingSet,AmbientCapabilities,RestrictAddressFamilies,ProtectSystem,User,Group,TimeoutStopUSec,RuntimeMaxUSec',
    ],
    5000,
    true,
  );
  return Object.fromEntries(
    output.split('\n').map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
}
function groupState(group) {
  if (
    !/^\/system.slice\/otto-upgrade-canary-[0-9a-f]{32}\.service$/.test(group)
  )
    reject('canary-cgroup-invalid');
  const root = `/sys/fs/cgroup${group}`;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) reject('canary-cgroup-invalid');
    const events = fs.readFileSync(`${root}/cgroup.events`, 'utf8');
    if (!/^populated [01]$/m.test(events))
      reject('canary-cgroup-state-invalid');
    return {
      populated: /^populated 1$/m.test(events),
      processes: fs
        .readFileSync(`${root}/cgroup.procs`, 'utf8')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    throw error;
  }
}

export function cleanStopProof(witness, current, group) {
  const empty =
    group.missing === true ||
    (group.populated === false && group.processes?.length === 0);
  if (!/^[0-9a-f]{32}$/.test(witness.invocationId ?? '') || !empty)
    return false;
  // Successful transient units may be collected. Only the root controller's
  // own systemd-run --wait exit (not a worker receipt) can bridge that gap.
  if (current.LoadState === 'not-found')
    return witness.waitExit === 0 && group.missing === true;
  return (
    current.InvocationID === witness.invocationId &&
    ['inactive', 'failed'].includes(current.ActiveState) &&
    current.MainPID === '0' &&
    current.Result === 'success' &&
    current.ExecMainCode === '1' &&
    current.ExecMainStatus === '0'
  );
}
function emptyStopProof(witness, current, group) {
  const identity =
    current.LoadState === 'not-found'
      ? group.missing === true
      : witness.invocationId && current.InvocationID === witness.invocationId;
  return (
    identity &&
    ['inactive', 'failed'].includes(current.ActiveState) &&
    current.MainPID === '0' &&
    (group.missing === true ||
      (group.populated === false && group.processes?.length === 0))
  );
}
export function validateMounts(mountinfo) {
  const mounts = new Map(
    mountinfo
      .trim()
      .split('\n')
      .map((line) => {
        const fields = line.split(' ');
        return [fields[4], fields[5]?.split(',') ?? []];
      }),
  );
  for (const mount of [
    '/',
    '/run',
    '/tmp',
    '/var/tmp',
    `${VIEW}/package`,
    `${VIEW}/control`,
    `${VIEW}/node`,
  ]) {
    if (!mounts.get(mount)?.includes('ro'))
      reject('canary-mount-isolation-mismatch');
  }
  if (!mounts.get(`${VIEW}/work`)?.includes('rw'))
    reject('canary-mount-isolation-mismatch');
  return true;
}
function attest(witness, current) {
  if (
    !/^[0-9a-f]{32}$/.test(current.InvocationID) ||
    !/^[1-9][0-9]*$/.test(current.MainPID) ||
    current.ControlGroup !== witness.cgroup ||
    current.User !== String(witness.uid) ||
    current.Group !== String(witness.gid) ||
    current.MemoryMax !== '524288000' ||
    current.MemorySwapMax !== '0' ||
    current.CPUQuotaPerSecUSec !== '500ms' ||
    current.TasksMax !== '64' ||
    current.PrivateNetwork !== 'yes' ||
    current.PrivateIPC !== 'yes' ||
    current.NoNewPrivileges !== 'yes' ||
    current.CapabilityBoundingSet !== '' ||
    current.AmbientCapabilities !== '' ||
    current.ProtectSystem !== 'strict' ||
    current.RestrictAddressFamilies?.split(' ').sort().join(' ') !==
      'AF_INET AF_INET6' ||
    current.RuntimeMaxUSec !== '3min' ||
    current.TimeoutStopUSec !== '1min'
  )
    reject('canary-systemd-isolation-mismatch');
  const proc = `/proc/${current.MainPID}`;
  const status = fs.readFileSync(`${proc}/status`, 'utf8');
  if (
    !new RegExp(
      `^Uid:\\s+${witness.uid}\\s+${witness.uid}\\s+${witness.uid}\\s+${witness.uid}$`,
      'm',
    ).test(status) ||
    !/^CapEff:\s+0+$/m.test(status) ||
    !/^CapPrm:\s+0+$/m.test(status) ||
    !/^CapBnd:\s+0+$/m.test(status) ||
    !/^CapAmb:\s+0+$/m.test(status) ||
    !/^Seccomp:\s+2$/m.test(status) ||
    !/^NoNewPrivs:\s+1$/m.test(status)
  )
    reject('canary-process-isolation-mismatch');
  if (
    fs.readlinkSync(`${proc}/ns/net`) === fs.readlinkSync('/proc/1/ns/net') ||
    fs.readlinkSync(`${proc}/ns/mnt`) === fs.readlinkSync('/proc/1/ns/mnt') ||
    fs.readlinkSync(`${proc}/ns/ipc`) === fs.readlinkSync('/proc/1/ns/ipc')
  )
    reject('canary-namespace-isolation-mismatch');
  validateMounts(fs.readFileSync(`${proc}/mountinfo`, 'utf8'));
  if (
    fs.readFileSync(`${proc}/cgroup`, 'utf8').trim() !== `0::${witness.cgroup}`
  )
    reject('canary-process-cgroup-mismatch');
  const cgroup = `/sys/fs/cgroup${witness.cgroup}`;
  if (
    fs.readFileSync(`${cgroup}/memory.max`, 'utf8').trim() !== '524288000' ||
    fs.readFileSync(`${cgroup}/memory.swap.max`, 'utf8').trim() !== '0' ||
    fs.readFileSync(`${cgroup}/pids.max`, 'utf8').trim() !== '64'
  )
    reject('canary-cgroup-limits-mismatch');
  const [quota, period] = fs
    .readFileSync(`${cgroup}/cpu.max`, 'utf8')
    .trim()
    .split(/\s+/)
    .map(Number);
  if (quota / period !== 0.5) reject('canary-cgroup-cpu-mismatch');
  return {
    ...witness,
    invocationId: current.InvocationID,
    pid: Number(current.MainPID),
  };
}

function configFromEnvironment(manifest, env) {
  return {
    version: manifest.version,
    buildId: manifest.buildCommit,
    schema: manifest.database?.schemaTo,
    publicUrl:
      env.OTTO_ENTERPRISE_PUBLIC_URL ||
      `https://${env.OTTO_PUBLIC_HOST || 'localhost'}:${env.OTTO_PUBLIC_PORT || '7777'}`,
    deploymentGrants: env.OTTO_ENTERPRISE_DEPLOYMENT_GRANTS || '',
    databaseKeyId:
      env.OTTO_DATABASE_ENCRYPTION_KEY_ID || 'offline-database-key',
    sms: validateSmsConfiguration(env, env.OTTO_ALLOW_SMS_DISABLED !== '1'),
  };
}
export function parseConfiguration(text) {
  const env = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trimStart();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7);
    const match = /^([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) reject('canary-configuration-invalid');
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}
function readOnlyCopy(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const visit = (file) => {
    const st = ordinary(file, { directory: fs.lstatSync(file).isDirectory() });
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(path.join(file, name));
      fs.chmodSync(file, 0o555);
    } else fs.chmodSync(file, st.mode & 0o111 ? 0o555 : 0o444);
  };
  visit(destination);
}
async function prepare(transaction) {
  const uid = Number(command('id', ['-u', 'otto-upgrade-canary']));
  const gid = Number(command('id', ['-g', 'otto-upgrade-canary']));
  if (
    !Number.isInteger(uid) ||
    uid < 1 ||
    !Number.isInteger(gid) ||
    gid < 1 ||
    command('id', ['-G', 'otto-upgrade-canary']) !== String(gid)
  )
    reject('canary-user-identity-invalid');
  // A previous controller failure must not share a static UID/proc view with
  // a new worker. upgrade.sh also serializes dry-runs using the deployment lock.
  for (const pid of fs
    .readdirSync('/proc')
    .filter((name) => /^[0-9]+$/.test(name))) {
    try {
      if (fs.statSync(`/proc/${pid}`).uid === uid)
        reject('canary-user-has-existing-process');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const available = Number(
    fs
      .readFileSync('/proc/meminfo', 'utf8')
      .match(/^MemAvailable:\s+(\d+) kB$/m)?.[1],
  );
  if (!(available >= 700 * 1024)) reject('canary-insufficient-memory');
  const disk = fs.statfsSync(transaction);
  if (disk.bavail * disk.bsize < 1024 ** 3) reject('canary-insufficient-disk');
  const canary = `${transaction}/canary`;
  ordinary(canary, { directory: true });
  ordinary(`${canary}/work`, { directory: true });
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  if (transaction.startsWith(`${packageRoot}/`))
    reject('canary-transaction-inside-package');
  const manifest = json(`${packageRoot}/release/manifest.json`);
  ordinary(`${transaction}/enterprise.env.before`);
  ordinary(`${transaction}/database-inspection.before.json`);
  const configuration = fs.readFileSync(
    `${transaction}/enterprise.env.before`,
    'utf8',
  );
  const config = configFromEnvironment(manifest, {
    ...parseConfiguration(configuration),
    OTTO_ALLOW_SMS_DISABLED: process.env.OTTO_ALLOW_SMS_DISABLED,
  });
  config.databaseKeyId =
    process.env.OTTO_DATABASE_ENCRYPTION_KEY_ID || config.databaseKeyId;
  if (
    !config.version ||
    !/^[0-9a-f]{40}$/.test(config.buildId) ||
    !Number.isInteger(config.schema)
  )
    reject('canary-manifest-invalid');
  config.configHash = hash(configuration);
  config.baselineHash = hash(
    fs.readFileSync(`${transaction}/database-inspection.before.json`),
  );
  config.manifestHash = hash(
    fs.readFileSync(`${packageRoot}/release/manifest.json`),
  );
  config.workerHash = await fileHash(fileURLToPath(import.meta.url));
  config.inputDatabaseHash = await fileHash(`${canary}/work/data.db`);
  config.nonce = randomBytes(16).toString('hex');
  fs.mkdirSync(`${canary}/control`, { mode: 0o755 });
  fs.chmodSync(`${canary}/control`, 0o755);
  fs.copyFileSync(
    `${transaction}/database-inspection.before.json`,
    `${canary}/control/baseline.json`,
    fs.constants.COPYFILE_EXCL,
  );
  fs.chmodSync(`${canary}/control/baseline.json`, 0o444);
  ordinary(process.env.OTTO_DATABASE_ENCRYPTION_KEY_FILE);
  fs.copyFileSync(
    process.env.OTTO_DATABASE_ENCRYPTION_KEY_FILE,
    `${canary}/database-key`,
    fs.constants.COPYFILE_EXCL,
  );
  fs.chmodSync(`${canary}/database-key`, 0o600);
  writeJson(`${canary}/config.json`, config);
  readOnlyCopy(packageRoot, `${canary}/package`);
  // Only the worker tree changes ownership. TXN and all rollback snapshots stay root:root 0700/0600.
  for (const name of fs.readdirSync(`${canary}/work`)) {
    ordinary(`${canary}/work/${name}`);
    fs.chownSync(`${canary}/work/${name}`, uid, gid);
  }
  fs.chownSync(`${canary}/work`, uid, gid);
  const unit = `otto-upgrade-canary-${config.nonce}.service`;
  const witness = {
    format: 1,
    unit,
    uid,
    gid,
    cgroup: `/system.slice/${unit}`,
    configHash: config.configHash,
    baselineHash: config.baselineHash,
    manifestHash: config.manifestHash,
    workerHash: config.workerHash,
    inputDatabaseHash: config.inputDatabaseHash,
    nonce: config.nonce,
    startedAt: Date.now(),
  };
  writeJson(`${transaction}/canary-controller.json`, witness);
  return {
    witness,
    request: {
      unit,
      uid,
      gid,
      transaction,
      packageRoot: `${canary}/package`,
      nodeRoot: path.dirname(path.dirname(fs.realpathSync(process.execPath))),
    },
  };
}

async function stop(transaction, clean = false) {
  const file = `${transaction}/canary-controller.json`;
  // prepare() cannot start systemd before this root-owned intent exists.
  if (!fs.existsSync(file) && !clean) return { notLaunched: true };
  const witness = json(file);
  if (
    !UNIT.test(witness.unit) ||
    witness.cgroup !== `/system.slice/${witness.unit}`
  )
    reject('canary-witness-invalid');
  const before = state(witness.unit);
  if (
    witness.invocationId &&
    before.LoadState !== 'not-found' &&
    before.InvocationID !== witness.invocationId
  )
    reject('canary-invocation-changed');
  if (before.LoadState !== 'not-found')
    command('systemctl', ['stop', '--no-block', witness.unit]);
  const deadline = Math.min(controlDeadline, performance.now() + 65_000);
  while (performance.now() < deadline) {
    const current = state(witness.unit);
    const group = groupState(witness.cgroup);
    if (emptyStopProof(witness, current, group)) {
      await sleep(50);
      const second = state(witness.unit);
      const secondGroup = groupState(witness.cgroup);
      if (!emptyStopProof(witness, second, secondGroup))
        reject('canary-stop-not-stable');
      if (clean && !cleanStopProof(witness, second, secondGroup))
        reject('canary-exit-not-clean');
      return { state: second, group: secondGroup };
    }
    await sleep(100);
  }
  reject('canary-stop-unknown');
}

async function launch(transaction) {
  const { witness: initial, request } = await prepare(transaction);
  let witness = initial;
  const deadline = performance.now() + 180_000;
  controlDeadline = deadline + 65_000;
  const runner = spawn('systemd-run', buildUnitArguments(request), {
    env: systemEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const runnerError = Buffer.alloc(8192);
  let runnerErrorBytes = 0;
  runner.stderr.on('data', (chunk) => {
    runnerErrorBytes += chunk.copy(
      runnerError,
      runnerErrorBytes,
      0,
      Math.min(chunk.length, runnerError.length - runnerErrorBytes),
    );
  });
  let runnerExit;
  runner.on('error', () => {
    runnerExit = -1;
  });
  runner.on('close', (code) => {
    runnerExit = code ?? -1;
  });
  try {
    for (;;) {
      if (performance.now() >= deadline || runnerExit !== undefined)
        reject('canary-start-or-run-failed');
      if (
        !witness.invocationId &&
        fs.existsSync(`${transaction}/canary/work/worker-ready.json`)
      ) {
        witness = attest(witness, state(witness.unit));
        writeJson(`${transaction}/canary-controller.json`, witness, false);
        publishControlHandshake(
          `${transaction}/canary/control/go.json`,
          witness.nonce,
        );
      }
      if (
        witness.invocationId &&
        fs.existsSync(`${transaction}/canary/work/health-complete.json`)
      )
        break;
      await sleep(100);
    }
    const proof = await stop(transaction);
    while (runnerExit === undefined && performance.now() < controlDeadline)
      await sleep(50);
    witness = { ...witness, waitExit: runnerExit };
    if (runnerExit !== 0 || !cleanStopProof(witness, proof.state, proof.group))
      reject('canary-exit-not-clean');
    writeJson(`${transaction}/canary-controller.json`, witness, false);
    const result = json(
      `${transaction}/canary/work/worker-result.json`,
      witness.uid,
    );
    if (
      result.nonce !== witness.nonce ||
      result.ok !== true ||
      result.runtimeExit !== 0 ||
      result.configHash !== witness.configHash ||
      result.baselineHash !== witness.baselineHash
    )
      reject('canary-worker-result-invalid');
    ordinary(`${transaction}/canary/work/data.db`, { owner: witness.uid });
    const databaseHash = await fileHash(`${transaction}/canary/work/data.db`);
    const resident = `${transaction}/canary/work/resident-recurring-tasks.json`;
    const residentHash = fs.existsSync(resident)
      ? (ordinary(resident, { owner: witness.uid }), await fileHash(resident))
      : null;
    writeJson(`${transaction}/canary-deliverable.json`, {
      ...witness,
      proof,
      databaseHash,
      residentHash,
    });
  } catch (error) {
    try {
      await stop(transaction);
    } catch {
      writeJson(
        `${transaction}/canary-recovery-required.json`,
        { reason: 'canary-stop-unknown' },
        false,
      );
    }
    writeJson(
      `${transaction}/canary-launch-diagnostic.json`,
      {
        runnerExit: runnerExit ?? null,
        kind: systemdRunDiagnostic(
          runnerError.subarray(0, runnerErrorBytes).toString('utf8'),
        ),
      },
      false,
    );
    throw error;
  }
}

async function verifyDeliverable(transaction) {
  const receipt = json(`${transaction}/canary-deliverable.json`);
  const witness = json(`${transaction}/canary-controller.json`);
  if (
    witness.workerHash !== (await fileHash(fileURLToPath(import.meta.url))) ||
    witness.manifestHash !==
      (await fileHash(`${transaction}/canary/package/release/manifest.json`))
  )
    reject('canary-deliverable-package-changed');
  if (
    receipt.invocationId !== witness.invocationId ||
    receipt.nonce !== witness.nonce ||
    receipt.configHash !==
      hash(fs.readFileSync(`${transaction}/enterprise.env.before`)) ||
    receipt.baselineHash !==
      hash(fs.readFileSync(`${transaction}/database-inspection.before.json`))
  )
    reject('canary-deliverable-identity-changed');
  await stop(transaction, true);
  ordinary(`${transaction}/canary/work/data.db`, { owner: witness.uid });
  if (
    receipt.databaseHash !==
    (await fileHash(`${transaction}/canary/work/data.db`))
  )
    reject('canary-deliverable-database-changed');
  const resident = `${transaction}/canary/work/resident-recurring-tasks.json`;
  const residentHash = fs.existsSync(resident)
    ? (ordinary(resident, { owner: witness.uid }), await fileHash(resident))
    : null;
  if (residentHash !== receipt.residentHash)
    reject('canary-deliverable-resident-changed');
}

async function worker() {
  if (
    process.platform !== 'linux' ||
    process.getuid() === 0 ||
    !process.env.CREDENTIALS_DIRECTORY ||
    !/^0::\/system.slice\/otto-upgrade-canary-[0-9a-f]{32}\.service\s*$/.test(
      fs.readFileSync('/proc/self/cgroup', 'utf8'),
    )
  )
    reject('canary-worker-requires-controller');
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  const config = JSON.parse(fs.readFileSync(`${credentials}/config`, 'utf8'));
  const env = runtimeEnvironment(
    config,
    credentials,
    randomBytes(32).toString('base64url'),
  );
  fs.mkdirSync(`${VIEW}/work/tmp`, { mode: 0o700 });
  let healthy = false;
  let stopping = false;
  let runtime;
  let runtimeResult;
  let runtimeExited;
  process.on('SIGTERM', () => {
    stopping = true;
    // KillMode=control-group already signals the runtime and every descendant.
    // Forwarding TERM again can interrupt a one-shot graceful shutdown handler.
  });
  writeJson(`${VIEW}/work/worker-ready.json`, { nonce: config.nonce });
  while (!fs.existsSync(`${VIEW}/control/go.json`)) {
    if (stopping) reject('canary-stopped-before-health');
    await sleep(50);
  }
  if (
    JSON.parse(fs.readFileSync(`${VIEW}/control/go.json`, 'utf8')).nonce !==
    config.nonce
  )
    reject('canary-controller-handshake-invalid');
  const startChild = (args) =>
    spawn(`${VIEW}/node`, args, { env, stdio: 'ignore' });
  const migration = startChild([
    `${VIEW}/package/tools/migrate-check.mjs`,
    `${VIEW}/package/release`,
    `${VIEW}/work`,
    '--baseline',
    `${VIEW}/control/baseline.json`,
  ]);
  const migrationResult = await new Promise((resolve) => {
    migration.on('error', () => resolve(-1));
    migration.on('exit', (code) => resolve(code ?? -1));
  });
  if (migrationResult !== 0 || stopping) reject('canary-migration-failed');
  runtime = startChild([`${VIEW}/package/release/run.mjs`]);
  runtimeExited = new Promise((resolve) => {
    runtime.on('error', () => {
      runtimeResult = -1;
      resolve();
    });
    runtime.on('exit', (code) => {
      runtimeResult = code ?? -1;
      resolve();
    });
  });
  // A single health budget includes readiness and every endpoint/body; retries never reset it.
  const healthDeadline = performance.now() + 30_000;
  while (
    !readinessPublicationComplete(
      env.OTTO_ENTERPRISE_READY_FILE,
      process.getuid(),
    )
  ) {
    if (
      stopping ||
      runtimeResult !== undefined ||
      performance.now() >= healthDeadline
    )
      reject('canary-readiness-failed');
    await sleep(100);
  }
  const ready = json(env.OTTO_ENTERPRISE_READY_FILE, process.getuid());
  if (
    ready.host !== '127.0.0.1' ||
    !Number.isInteger(ready.port) ||
    ready.port < 1 ||
    ready.port > 65535 ||
    ready.version !== config.version ||
    ready.buildCommit !== config.buildId
  )
    reject('canary-readiness-identity-mismatch');
  await runHealthChecks({
    baseUrl: `http://127.0.0.1:${ready.port}`,
    expectedVersion: config.version,
    expectedBuild: config.buildId,
    expectedSchema: config.schema,
    env,
    sms: config.sms,
    deadline: healthDeadline,
  });
  healthy = true;
  writeJson(`${VIEW}/work/health-complete.json`, { nonce: config.nonce });
  // The controller starts systemd's 60s stopping budget before asking the runtime to drain.
  while (!stopping) {
    if (runtimeResult !== undefined)
      reject('canary-runtime-exited-before-stop');
    await sleep(50);
  }
  await runtimeExited;
  if (!healthy || runtimeResult !== 0) reject('canary-runtime-exit-not-clean');
  writeJson(`${VIEW}/work/worker-result.json`, {
    ok: true,
    nonce: config.nonce,
    runtimeExit: runtimeResult,
    configHash: config.configHash,
    baselineHash: config.baselineHash,
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '_worker') return worker();
  if (
    argv.length !== 3 ||
    argv[1] !== '--transaction' ||
    !['launch', 'stop', 'verify-deliverable'].includes(argv[0])
  )
    reject('canary-command-invalid');
  const transaction = transactionRoot(argv[2]);
  if (argv[0] === 'launch') await launch(transaction);
  else {
    controlDeadline = performance.now() + 65_000;
    if (fs.existsSync(`${transaction}/canary-recovery-required.json`))
      reject('canary-stop-unknown');
    if (argv[0] === 'stop') await stop(transaction);
    else await verifyDeliverable(transaction);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code = /^canary-[a-z-]+$/.test(error.message)
      ? error.message
      : 'canary-validation-failed';
    process.stderr.write(
      `[Otto Canary] ${code}; preserve transaction evidence\n`,
    );
    process.exitCode = 5;
    // Let systemd stop every child under its 60s budget on worker failure.
    if (process.argv[2] === '_worker') process.exit(5);
  });
}
