#!/usr/bin/env node
/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
 * Offline, additive source capture. Never installs dependencies or calls a model.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RULES = 'packages/evals/baselines/semantic-stage0-v1.json';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const json = (data) => JSON.stringify(data, null, 2) + '\n';
const git = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const split = (text) => text.split('\0').filter(Boolean);
const excludedDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'bundle',
  'target',
  'coverage',
  'artifacts',
  '.cache',
  'vite-cache',
  '.vite',
  '.next',
  '.otto-user',
  '.easycode',
  '.easycode-user',
  'electron-dist',
]);

function safeRelative(file) {
  if (
    !file ||
    file.includes('\\') ||
    file.includes(':') ||
    file.includes('\0') ||
    file.startsWith('/') ||
    file.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Unsafe relative source path');
  return file;
}
function assertNoLinks(root, relative = '') {
  let current = path.resolve(root);
  // Check ancestors too: a trusted-looking directory can be a junction.
  const ancestors = [];
  for (let p = current; ; p = path.dirname(p)) {
    ancestors.push(p);
    if (path.dirname(p) === p) break;
  }
  for (const p of ancestors.reverse()) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error('Source/destination link refused');
  }
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error('Source link refused');
  }
}
function exclusion(file) {
  const segments = file.split('/');
  if (segments.some((p) => excludedDirs.has(p)))
    return 'generated_or_runtime_directory';
  const base = segments.at(-1);
  if (
    /^(?:\.env(?:\..*)?|\.npmrc|id_rsa|id_ed25519|credentials\.json|settings\.json)$/i.test(
      base,
    ) &&
    !/\.example$|\.template$/i.test(base)
  )
    return 'credential_or_local_configuration';
  if (
    /\.(?:pem|key|pfx|p12|dpapi|exe|msi|dmg|tgz|tsbuildinfo|log)$/i.test(base)
  )
    return 'private_or_generated_payload';
  if (/\.(?:db|sqlite|sqlite3)$/i.test(base) && !file.includes('/fixtures/'))
    return 'runtime_database';
  if (file.startsWith('.otto/') && !file.startsWith('.otto/skills/'))
    return 'user_runtime_state';
  return null;
}
function checkCredentials(bytes, file) {
  // Do not print matched values. This catches high-confidence tokens, not all secrets.
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  if (
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,})\b/.test(
      text,
    ) ||
    /^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{32,}/m.test(
      text,
    )
  )
    throw new Error(`Probable embedded credential; capture refused: ${file}`);
}
export function hashEntries(entries) {
  return sha(
    JSON.stringify(
      entries
        .map(({ path: p, bytes, sha256 }) => ({ path: p, bytes, sha256 }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );
}
export function sourceInventory(root) {
  root = path.resolve(root);
  assertNoLinks(root);
  const tracked = new Set(split(git(root, ['ls-files', '-z', '--cached'])));
  const others = split(
    git(root, ['ls-files', '-z', '--others', '--exclude-standard']),
  );
  const changed = new Set(
    split(git(root, ['diff', '--name-only', '-z', 'HEAD'])),
  );
  const candidates = [...new Set([...tracked, ...others])].sort();
  const files = [],
    deleted = [],
    excluded = [];
  let total = 0;
  for (const relative of candidates) {
    safeRelative(relative);
    const reason = exclusion(relative);
    if (reason) {
      excluded.push({ path: relative, reason });
      continue;
    }
    assertNoLinks(root, relative);
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) {
      deleted.push(relative);
      continue;
    }
    if (!lstatSync(absolute).isFile())
      throw new Error(`Non-file source entry refused: ${relative}`);
    const bytes = readFileSync(absolute);
    total += bytes.length;
    if (bytes.length > 32 * 1024 * 1024 || total > 256 * 1024 * 1024)
      throw new Error(
        'Source size budget exceeded; inspect scope before capture',
      );
    checkCredentials(bytes, relative);
    files.push({
      path: relative,
      bytes: bytes.length,
      sha256: sha(bytes),
      state: !tracked.has(relative)
        ? 'untracked'
        : changed.has(relative)
          ? 'modified'
          : 'tracked',
    });
  }
  return {
    files,
    deleted,
    excluded,
    bytes: total,
    fingerprint: hashEntries(files),
  };
}

function numberSetting(env, key, label, positive) {
  if (!env[key]?.trim()) return null;
  const value = Number(env[key]);
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0))
    throw new Error(`Invalid ${label}`);
  return value;
}
export function resolveEvaluationProtocol(env, rules) {
  const model = env.OTTO_EVAL_MODEL?.trim() || null;
  const revision = env.OTTO_EVAL_MODEL_REVISION?.trim() || null;
  let endpointHash = null;
  if (env.OTTO_EVAL_BASE_URL) {
    let endpoint;
    try {
      endpoint = new URL(env.OTTO_EVAL_BASE_URL);
    } catch {
      throw new Error('Invalid evaluation endpoint');
    }
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !(
        endpoint.protocol === 'https:' ||
        (endpoint.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
      )
    )
      throw new Error('Unsafe evaluation endpoint');
    endpointHash = sha(endpoint.href.replace(/\/$/, ''));
  }
  const maxCostUsd = numberSetting(
    env,
    'OTTO_EVAL_MAX_COST_USD',
    'budget',
    true,
  );
  const inputPerMillion = numberSetting(
    env,
    'OTTO_EVAL_INPUT_PER_MILLION',
    'input rate',
    false,
  );
  const outputPerMillion = numberSetting(
    env,
    'OTTO_EVAL_OUTPUT_PER_MILLION',
    'output rate',
    false,
  );
  const conditions = {
    datasetHash: sha(JSON.stringify(rules)),
    provider: 'openai-compatible',
    model,
    revision,
    endpointHash,
    maxCostUsd,
    inputPerMillion,
    outputPerMillion,
    maxOutputTokens: 2048,
    maxRounds: 10,
    maxCaseMs: 150000,
    requestTimeoutMs: 45000,
    maxBatchRuns: 24,
    repeats: 1,
    parallelism: 1,
    approval: 'default',
    data: 'synthetic-only',
    tools: 'fixture-allowlist-only',
  };
  const pending = Object.entries({
    model,
    revision,
    endpointHash,
    maxCostUsd,
    inputPerMillion,
    outputPerMillion,
  })
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (!env.OTTO_EVAL_API_KEY?.trim()) pending.push('credential');
  return {
    schemaVersion: 1,
    conditions,
    fingerprint: sha(JSON.stringify(conditions)),
    live: {
      model,
      revision,
      maxCostUsd,
      ready: pending.length === 0,
      pending,
      callsMade: 0,
      estimatedCost: null,
      status: 'not_run',
      note: 'Readiness is not permission to run. Provider billing cap and explicit opt-in still required.',
    },
  };
}
export function assertComparableProtocols(before, after) {
  if (!before.live.ready || !after.live.ready)
    throw new Error('Evaluation conditions pending');
  if (
    before.fingerprint !== sha(JSON.stringify(before.conditions)) ||
    after.fingerprint !== sha(JSON.stringify(after.conditions)) ||
    before.fingerprint !== after.fingerprint
  )
    throw new Error('Protocols are not comparable');
}
export function assertComparableBaselines(before, after) {
  assertComparableProtocols(before.protocol, after.protocol);
  if (
    !before.identities?.harnessFingerprint ||
    before.identities.harnessFingerprint !==
      after.identities?.harnessFingerprint
  )
    throw new Error(
      'Grader/fixture harness changed; baselines are not comparable',
    );
  for (const key of [
    'nodeExecutableSha256',
    'platform',
    'arch',
    'osRelease',
    'timeZone',
    'cpuModel',
    'logicalCpus',
    'ramBytes',
    'lockSha256',
    'installed',
    'missing',
  ]) {
    if (
      JSON.stringify(before.environment?.[key]) !==
      JSON.stringify(after.environment?.[key])
    )
      throw new Error(
        `Environment changed; baselines are not comparable: ${key}`,
      );
  }
}
export function environmentInventory(root) {
  const lock = JSON.parse(
    readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
  );
  const installed = [],
    missing = [];
  for (const [relative, entry] of Object.entries(lock.packages ?? {})) {
    if (!relative.includes('node_modules/') || entry.link) continue;
    safeRelative(relative);
    const p = path.join(root, relative, 'package.json');
    if (!existsSync(p)) {
      missing.push(relative);
      continue;
    }
    const bytes = readFileSync(p);
    const pkg = JSON.parse(bytes.toString('utf8'));
    installed.push({
      path: relative,
      name: pkg.name,
      version: pkg.version,
      packageJsonSha256: sha(bytes),
      lockVersion: entry.version ?? null,
    });
  }
  return {
    node: process.version,
    nodeExecutableSha256: sha(readFileSync(process.execPath)),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cpuModel: os.cpus()[0]?.model ?? null,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    lockSha256: sha(readFileSync(path.join(root, 'package-lock.json'))),
    installed,
    missing,
    limitation:
      'Installed package metadata inventoried, not a byte-for-byte dependency archive. No install, scripts or native build performed.',
  };
}
export function freezeBaseline(root, destination) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  const relation = path.relative(root, destination);
  if (
    !relation ||
    (!relation.startsWith('..' + path.sep) &&
      relation !== '..' &&
      !path.isAbsolute(relation))
  )
    throw new Error('Snapshot destination must be outside source worktree');
  assertNoLinks(destination);
  if (existsSync(destination))
    throw new Error('Snapshot destination already exists; never overwrite');
  const source = sourceInventory(root);
  const rules = existsSync(path.join(root, RULES))
    ? JSON.parse(readFileSync(path.join(root, RULES), 'utf8'))
    : { schemaVersion: 1, dataset: 'unconfigured', cases: [] };
  const environment = environmentInventory(root);
  const gitState = {
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    branch: git(root, ['branch', '--show-current']).trim(),
    statusSha256: sha(
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ),
  };
  const protocol = resolveEvaluationProtocol(process.env, rules);
  mkdirSync(path.join(destination, 'source'), { recursive: true });
  for (const entry of source.files) {
    assertNoLinks(root, entry.path);
    const bytes = readFileSync(path.join(root, entry.path));
    if (sha(bytes) !== entry.sha256)
      throw new Error(
        'Source changed during capture; incomplete snapshot must not be used',
      );
    const target = path.join(destination, 'source', entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  const after = sourceInventory(root);
  if (
    after.fingerprint !== source.fingerprint ||
    JSON.stringify(after.deleted) !== JSON.stringify(source.deleted) ||
    gitState.statusSha256 !==
      sha(
        git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      )
  )
    throw new Error(
      'Source changed during capture; incomplete snapshot must not be used',
    );
  const manifest = {
    schemaVersion: 1,
    kind: 'offline-source-baseline',
    createdAt: new Date().toISOString(),
    git: gitState,
    source,
    identities: {
      runtimeFingerprint: hashEntries(
        source.files.filter(
          (f) =>
            !f.path.startsWith('packages/evals/') &&
            !f.path.startsWith('docs/') &&
            !f.path.startsWith('scripts/tests/') &&
            !/\.(?:test|scenario\.test)\.[cm]?[jt]sx?$/.test(f.path),
        ),
      ),
      harnessFingerprint: hashEntries(
        source.files.filter(
          (f) =>
            f.path.startsWith('packages/evals/') ||
            f.path.startsWith('scripts/tests/') ||
            /scripts\/(?:agent-eval-baseline|run-agent-baseline|agent-baseline\.vitest\.config)\.mjs$/.test(
              f.path,
            ),
        ),
      ),
    },
    environment,
    protocol,
    limitations: [
      'Ignored files, generated dependencies/builds, credentials and user state are not captured.',
      'High-confidence credential scan is not proof all possible secrets are absent; local-only, do not publish the snapshot.',
      'Deterministic and scripted-provider results are not real-model quality measurements.',
    ],
  };
  const content = json(manifest);
  writeFileSync(path.join(destination, 'manifest.json'), content, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    path.join(destination, 'manifest.sha256'),
    sha(content) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return manifest;
}
export function verifyBaseline(directory) {
  assertNoLinks(directory);
  const content = readFileSync(path.join(directory, 'manifest.json'));
  if (
    sha(content) !==
    readFileSync(path.join(directory, 'manifest.sha256'), 'utf8').trim()
  )
    throw new Error('Manifest integrity mismatch');
  const m = JSON.parse(content);
  if (
    m.schemaVersion !== 1 ||
    m.kind !== 'offline-source-baseline' ||
    hashEntries(m.source.files) !== m.source.fingerprint
  )
    throw new Error('Manifest integrity/schema mismatch');
  const source = path.join(directory, 'source');
  const missing = [],
    changed = [],
    unexpected = [];
  const expected = new Set();
  for (const e of m.source.files) {
    safeRelative(e.path);
    assertNoLinks(source, e.path);
    if (expected.has(e.path)) throw new Error('Duplicate manifest source path');
    expected.add(e.path);
    const p = path.join(source, e.path);
    if (!existsSync(p)) {
      missing.push(e.path);
      continue;
    }
    const bytes = readFileSync(p);
    if (bytes.length !== e.bytes || sha(bytes) !== e.sha256)
      changed.push(e.path);
  }
  function walk(relative = '') {
    for (const entry of readdirSync(path.join(source, relative), {
      withFileTypes: true,
    })) {
      const p = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) {
        unexpected.push(p);
        continue;
      }
      if (entry.isDirectory()) walk(p);
      else if (!expected.has(p)) unexpected.push(p);
    }
  }
  walk();
  return {
    valid: !missing.length && !changed.length && !unexpected.length,
    fingerprint: m.source.fingerprint,
    files: m.source.files.length,
    missing,
    changed,
    unexpected,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [command, target] = process.argv.slice(2);
    if (!target || !['freeze', 'verify'].includes(command))
      throw new Error(
        'Usage: node scripts/agent-eval-baseline.mjs freeze|verify ABSOLUTE_DIRECTORY',
      );
    if (!path.isAbsolute(target))
      throw new Error('Use an absolute target directory');
    if (command === 'freeze') {
      const m = freezeBaseline(process.cwd(), target);
      console.log(
        json({
          directory: target,
          files: m.source.files.length,
          bytes: m.source.bytes,
          fingerprint: m.source.fingerprint,
          modified: m.source.files.filter((f) => f.state === 'modified').length,
          untracked: m.source.files.filter((f) => f.state === 'untracked')
            .length,
          live: m.protocol.live,
        }),
      );
    } else {
      const result = verifyBaseline(target);
      console.log(json(result));
      if (!result.valid) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
