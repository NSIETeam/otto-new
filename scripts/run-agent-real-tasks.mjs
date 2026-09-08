/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyBaseline,
  environmentInventory,
} from './agent-eval-baseline.mjs';

export const TASK_ORDER = [
  'login-retry',
  'utc-display',
  'ppt-preview',
  'dual-artifact',
  'steer-stop-backend',
  'steer-replace-artifact',
  'restart-known-receipt',
  'restart-unknown-outcome',
  'inbox-read-return',
  'project-delete',
  'park-replies',
  'tenant-boundary',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
export async function runRealTaskInfrastructure(
  snapshot,
  dependencies,
  cases = TASK_ORDER,
) {
  snapshot = path.resolve(snapshot);
  dependencies = path.resolve(dependencies);
  if (
    !cases.length ||
    new Set(cases).size !== cases.length ||
    cases.some((id) => !TASK_ORDER.includes(id))
  )
    throw new Error('Unknown/duplicate/empty case selection');
  if (!verifyBaseline(snapshot).valid)
    throw new Error('Snapshot integrity check failed');
  const manifest = JSON.parse(
    readFileSync(path.join(snapshot, 'manifest.json'), 'utf8'),
  );
  const environment = environmentInventory(dependencies);
  if (environment.lockSha256 !== manifest.environment.lockSha256)
    throw new Error(
      'Dependency lock differs from snapshot; do not silently attribute the difference to product code',
    );
  const vitest = path.join(dependencies, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest))
    throw new Error('Local Vitest unavailable; no installation attempted');
  mkdirSync(path.join(snapshot, 'real-task-runs'), { recursive: true });
  const run = mkdtempSync(
    path.join(snapshot, 'real-task-runs/infrastructure-'),
  );
  const workspace = path.join(run, 'source');
  const output = path.join(run, 'results');
  mkdirSync(workspace);
  mkdirSync(output);
  for (const entry of manifest.source.files) {
    const source = path.join(snapshot, 'source', entry.path);
    if (hash(readFileSync(source)) !== entry.sha256)
      throw new Error('Snapshot changed before restoration');
    const destination = path.join(workspace, entry.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  symlinkSync(
    path.join(dependencies, 'node_modules'),
    path.join(workspace, 'node_modules'),
    'junction',
  );
  for (const relative of JSON.parse(
    readFileSync(path.join(workspace, 'package.json'), 'utf8'),
  ).workspaces ?? []) {
    if (
      typeof relative !== 'string' ||
      !/^[a-z\d_/-]+$/iu.test(relative) ||
      relative.includes('..') ||
      path.isAbsolute(relative)
    )
      throw new Error('Unsafe workspace dependency path');
    if (existsSync(path.join(dependencies, relative, 'node_modules')))
      symlinkSync(
        path.join(dependencies, relative, 'node_modules'),
        path.join(workspace, relative, 'node_modules'),
        'junction',
      );
  }
  const protocol = {
    schemaVersion: 2,
    kind: 'real-product-scripted-infrastructure',
    cases,
    model: 'loopback-scripted-not-a-trained-model',
    realModelQuality: false,
    snapshotManifestHash: hash(
      readFileSync(path.join(snapshot, 'manifest.json')),
    ),
    sourceFingerprint: manifest.source.fingerprint,
    contractHash: hash(
      readFileSync(
        path.join(workspace, 'packages/evals/src/realTasks/evidence.ts'),
      ),
    ),
    fixtureHash: hash(
      readFileSync(
        path.join(workspace, 'packages/evals/src/realTasks/scriptedPlans.ts'),
      ),
    ),
    toolSourceBinding:
      'Restored actual TypeScript + exact workspace aliases; no generated dist, vi.mock, fake window.otto or business substitutes.',
    environment,
    parallelism: 1,
    runTimeoutMs: 900000,
    limit:
      'Dependency package metadata is attested, not every installed dependency byte. This run cannot be a fair fixed-model comparison or release evidence.',
  };
  const experimentHash = hash(json(protocol));
  writeFileSync(path.join(output, 'protocol.json'), json(protocol), {
    flag: 'wx',
  });
  writeFileSync(
    path.join(output, 'identity.json'),
    json({
      experimentHash,
      sourceFingerprint: manifest.source.fingerprint,
      cases,
    }),
    { flag: 'wx' },
  );
  const env = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'PATH',
    'Path',
    'TEMP',
    'TMP',
    'PATHEXT',
  ])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    OTTO_REAL_TASK_OUTPUT: output,
    OTTO_BASELINE_OUTPUT: output,
    OTTO_USER_DIR: path.join(run, 'profile'),
    OTTO_LIVE_EVAL: '0',
    OTTO_DISABLE_MODEL_HEALTH_CHECK: '1',
    NO_COLOR: '1',
    CI: '1',
  });
  const started = Date.now();
  const execution = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        vitest,
        'run',
        '--config',
        'scripts/agent-real-matrix.vitest.config.mjs',
        '--reporter=json',
        `--outputFile=${path.join(output, 'vitest.json')}`,
      ],
      { cwd: workspace, env, shell: false, windowsHide: true },
    );
    let stdout = '',
      stderr = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const cleanup = spawn(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' },
        );
        cleanup.once('error', () => child.kill('SIGKILL'));
      } else child.kill('SIGKILL');
    }, protocol.runTimeoutMs);
    child.stdout.on('data', (b) => {
      stdout = (stdout + String(b)).slice(-1000000);
    });
    child.stderr.on('data', (b) => {
      stderr = (stderr + String(b)).slice(-1000000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut,
        stdout,
        stderr,
        error: String(error),
      });
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
  const changed = manifest.source.files
    .filter(
      (f) =>
        !existsSync(path.join(workspace, f.path)) ||
        hash(readFileSync(path.join(workspace, f.path))) !== f.sha256,
    )
    .map((f) => f.path);
  const finalEnvironment = environmentInventory(dependencies);
  const environmentUnchanged =
    hash(json(finalEnvironment)) === hash(json(environment));
  const results = cases.map((caseId) => {
    const p = path.join(output, `${caseId}.result.json`);
    return existsSync(p)
      ? JSON.parse(readFileSync(p, 'utf8'))
      : {
          caseId,
          status: 'not_run',
          independentPass: null,
          traceComplete: false,
          reason: 'Collector did not produce a terminal case record',
        };
  });
  const report = {
    schemaVersion: 2,
    experimentHash,
    sourceFingerprint: manifest.source.fingerprint,
    sourceUnchanged: !changed.length,
    changed,
    environmentUnchanged,
    mode: 'scripted',
    realModelScore: null,
    humanReview: 'pending',
    productionReleaseAllowed: false,
    durationMs: Date.now() - started,
    execution,
    results,
  };
  writeFileSync(path.join(output, 'report.json'), json(report), { flag: 'wx' });
  const lines = [
    '# 六类真实产品链路：设施运行记录',
    '',
    `源码指纹：\`${report.sourceFingerprint}\``,
    '',
    '脚本模型只检查执行设施；不计入真实模型成绩。收集器退出码不代表产品通过。',
    '',
    '| 任务 | 执行状态 | 独立验收 | 证据完整 |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.caseId} | ${r.status} | ${r.independentPass === true ? '通过' : r.independentPass === false ? '失败' : '未知'} | ${r.traceComplete ? '是' : '否'} |`,
    ),
    '',
    'GUI 未具备可追溯的完整隔离桌面构建；点击驱动不得用 jsdom 或模拟 IPC 替代。',
    '文件预览缺少真实窗口全生命周期外部应用启动监测，不能证明未调用外部应用。',
    '失败与未知项均不允许发布。企业 API 成绩不是模型成绩。',
    '依赖仅作包元数据前后核对，未作全字节封存，因此不用于前后版本因果比较。',
    '完整证据见同目录 report.json 及各任务子目录。',
    '',
  ];
  writeFileSync(path.join(output, 'report.md'), lines.join('\n'), {
    flag: 'wx',
  });
  writeFileSync(
    path.join(output, 'report.sha256'),
    hash(readFileSync(path.join(output, 'report.json'))) + '\n',
    { flag: 'wx' },
  );
  return {
    run,
    report: path.join(output, 'report.md'),
    executionExitCode: execution.exitCode,
    sourceUnchanged: !changed.length,
    environmentUnchanged,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [snapshot, dependencies, ...cases] = process.argv.slice(2);
  if (!snapshot || !dependencies)
    throw new Error(
      'Usage: node scripts/run-agent-real-tasks.mjs <new-snapshot> <dependency-worktree> [case-id ...] (scripted infrastructure only)',
    );
  console.log(
    JSON.stringify(
      await runRealTaskInfrastructure(
        snapshot,
        dependencies,
        cases.length ? cases : TASK_ORDER,
      ),
      null,
      2,
    ),
  );
}
