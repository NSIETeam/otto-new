/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskContractLedger } from './taskContract.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it('retains bound native tests across append/restart, but rejects changed inputs and superseded objectives', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-native-evidence-'));
  dirs.push(root);
  const file = path.join(root, 'login.ts');
  writeFileSync(file, 'version A');
  const ledger = new TaskContractLedger('修复登录', undefined, root);
  const criterion = {
    id: 'test',
    description: '登录测试',
    kind: 'process',
    command: 'npm test',
    directory: root,
    inputFiles: [file],
  };
  const objective = {
    id: 'login',
    description: '修复登录',
    sourceQuote: '修复登录',
    dependsOn: [],
    criteria: [criterion],
    evidence: [],
  };
  ledger.update({ expectedRevision: 0, objectives: [objective] });
  const tool: ToolCall = {
    id: 'test',
    toolName: 'run_shell_command',
    status: ToolCallStatus.Success,
    parameters: { command: 'npm test', directory: root },
    result: {
      success: true,
      toolName: 'run_shell_command',
      executionTime: 1,
      data: 'secret-output-not-to-persist',
      process: {
        command: 'npm test',
        directory: root,
        status: 'exited',
        exitCode: 0,
        signal: null,
      },
    },
  };
  ledger.observe(tool, false);
  ledger.update({
    expectedRevision: 1,
    objectives: [
      { ...objective, evidence: [{ criterionId: 'test', toolCallId: 'test' }] },
    ],
  });
  expect(ledger.checks()[0].status).toBe('passed');
  expect(ledger.rebase('修复登录\n新增退出功能').checks()[0].status).toBe(
    'passed',
  );
  expect(ledger.rebase('只解释缓存').snapshot().objectives).toEqual([]);
  const checkpoint = ledger.nativeCheckpoint();
  expect(JSON.stringify(checkpoint)).not.toContain('secret-output');
  const restored = new TaskContractLedger('修复登录', ledger.snapshot(), root);
  restored.restoreNativeCheckpoint(checkpoint);
  expect(restored.checks()[0].status).toBe('passed');
  writeFileSync(file, 'version B');
  expect(restored.checks()[0].status).toBe('not_run');
  const stale = new TaskContractLedger('修复登录', ledger.snapshot(), root);
  stale.restoreNativeCheckpoint(checkpoint);
  expect(stale.checks()[0].status).toBe('not_run');
  expect(() =>
    stale.restoreNativeCheckpoint({ ...checkpoint, mutationRevision: -1 }),
  ).toThrow();
});
