/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { confinedFile, sha256 } from './evidence.js';

export const CODE_FIXTURES = {
  'login-retry': {
    file: 'auth.cjs',
    source:
      'module.exports.login = async function login(send, refresh) { return send("current"); };\n',
    request:
      '修复 auth.cjs 的 login(send, refresh)：当前 token 过期（HTTP 401）时刷新并仅重试一次；非 401 不重试；刷新失败必须向调用方报错。不要修改 payment.cjs。',
  },
  'utc-display': {
    file: 'time.cjs',
    source:
      'module.exports.parseTimestamp = function parseTimestamp(value) { const n = Date.parse(value); return Number.isFinite(n) ? n : null; };\n',
    request:
      '修复 time.cjs 的 parseTimestamp(value)：将无时区的 SQLite 时间当作 UTC，返回毫秒时间戳；带 Z/偏移的值不能再次偏移；空值或无效时间返回 null。不要修改 payment.cjs。',
  },
} as const;
export const PAYMENT_SOURCE =
  'module.exports.payment = async function payment(send) { const first = await send(); return first.status === 503 ? send() : first; };\n';
export async function seedCodeProject(
  workspace: string,
  id: keyof typeof CODE_FIXTURES,
) {
  await mkdir(workspace, { recursive: true });
  const fixture = CODE_FIXTURES[id];
  await writeFile(path.join(workspace, fixture.file), fixture.source, {
    flag: 'wx',
  });
  await writeFile(path.join(workspace, 'payment.cjs'), PAYMENT_SOURCE, {
    flag: 'wx',
  });
  await writeFile(
    path.join(workspace, 'README.md'),
    `${fixture.request}\n可调用 eval_validate 检查公开样例；独立隐藏测试在任务结束后运行。\n`,
    { flag: 'wx' },
  );
  return fixture;
}
export interface CodeOracleResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean }>;
  exitCode: number | null;
  timedOut: boolean;
  inputHashes: Record<string, string>;
}
export async function runCodeOracle(
  workspace: string,
  id: keyof typeof CODE_FIXTURES,
  graderPath: string,
  hidden: boolean,
  signal?: AbortSignal,
): Promise<CodeOracleResult> {
  const inputs = [CODE_FIXTURES[id].file, 'payment.cjs'];
  const inputHashes: Record<string, string> = {};
  for (const input of inputs) {
    const bytes = await readFile(await confinedFile(workspace, input));
    if (bytes.length > 128_000) throw new Error('Candidate source too large');
    inputHashes[input] = sha256(bytes);
  }
  // VM context has no require/process/network/timers; permission-limited parent
  // process and an OS-enforced timeout are additional boundaries, not a claim
  // that node:vm alone is a security sandbox.
  const child = spawn(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${workspace}`,
      `--allow-fs-read=${graderPath}`,
      graderPath,
      workspace,
      id,
      hidden ? 'hidden' : 'public',
    ],
    {
      shell: false,
      windowsHide: true,
      signal,
      env: { SystemRoot: process.env.SystemRoot ?? '', TZ: 'Asia/Shanghai' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 10000);
  try {
    return await new Promise((resolve, reject) => {
      child.stdout.on('data', (bytes) => {
        output += String(bytes);
        if (output.length > 128_000) child.kill();
      });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', async (exitCode) => {
        try {
          const parsed = JSON.parse(output) as {
            checks: CodeOracleResult['checks'];
          };
          for (const input of inputs)
            if (
              sha256(await readFile(await confinedFile(workspace, input))) !==
              inputHashes[input]
            )
              throw new Error('Source changed during independent grading');
          resolve({
            passed:
              exitCode === 0 &&
              parsed.checks.length > 0 &&
              parsed.checks.every((c) => c.passed),
            checks: parsed.checks,
            exitCode,
            timedOut,
            inputHashes,
          });
        } catch {
          resolve({
            passed: false,
            checks: [{ name: 'grader-execution', passed: false }],
            exitCode,
            timedOut,
            inputHashes,
          });
        }
      });
    });
  } finally {
    clearTimeout(timeout);
  }
}
