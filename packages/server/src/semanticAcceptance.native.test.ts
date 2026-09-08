/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskContractLedger } from './taskContract.js';
import { ToolCallStatus } from './protocol.js';

it.each([
  'real-assertion',
  'constant-assertion',
  'modified-after-review',
  'throw-match',
  'async-return',
  'destructured',
  'unsupported-helper',
  'replaced-assertion',
  'short-circuit',
])(
  'real node:test receipt plus current test-source audit: %s',
  async (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), 'otto-stage5-native-'));
    try {
      const file = path.join(root, 'acceptance.test.cjs');
      const data = path.join(root, 'result.json');
      writeFileSync(data, '{"value":2}');
      const body =
        mode === 'replaced-assertion'
          ? '{ const assert={equal(){}}; assert.equal(JSON.parse(fs.readFileSync("result.json","utf8")).value,999); }'
          : mode === 'short-circuit'
            ? '{ false && assert.equal(JSON.parse(fs.readFileSync("result.json","utf8")).value,999); }'
            : mode === 'constant-assertion'
              ? 'assert.equal(true,true)'
              : mode === 'throw-match'
                ? 'assert.throws(() => JSON.parse("broken"), SyntaxError)'
                : mode === 'async-return'
                  ? '{ return assert.rejects(async () => JSON.parse("broken"), SyntaxError); }'
                  : mode === 'destructured'
                    ? '{ const {value} = JSON.parse(fs.readFileSync("result.json","utf8")); assert.equal(value,2); }'
                    : mode === 'unsupported-helper'
                      ? 'helper()'
                      : "assert.equal(JSON.parse(fs.readFileSync('result.json','utf8')).value,2)";
      writeFileSync(
        file,
        `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');function helper(){assert.equal(JSON.parse(fs.readFileSync('result.json','utf8')).value,2)};test('data value',()=>${body});`,
      );
      const ledger = new TaskContractLedger('验证数据', undefined, root);
      const command = 'node --test --test-reporter=tap acceptance.test.cjs';
      ledger.update({
        expectedRevision: 0,
        objectives: [
          {
            id: 'data',
            description: '验证数据',
            sourceQuote: '验证数据',
            dependsOn: [],
            criteria: [
              {
                id: 'check',
                kind: 'process',
                description: '数据值',
                command,
                directory: root,
                inputFiles: [file, data],
                testCase: { name: 'data value', scenario: 'normal' },
              },
            ],
            evidence: [{ criterionId: 'check', toolCallId: 'native-test' }],
          },
        ],
      });
      const parameters = { command, directory: root };
      ledger.observe(
        {
          id: 'native-test',
          toolName: 'run_shell_command',
          parameters,
          status: ToolCallStatus.Executing,
        },
        false,
      );
      const run = spawnSync(
        process.execPath,
        ['--test', '--test-reporter=tap', 'acceptance.test.cjs'],
        {
          cwd: root,
          shell: false,
          windowsHide: true,
          timeout: 10000,
          encoding: 'utf8',
        },
      );
      expect(run.status).toBe(0);
      ledger.observe(
        {
          id: 'native-test',
          toolName: 'run_shell_command',
          parameters,
          status: ToolCallStatus.Success,
          result: {
            success: true,
            toolName: 'run_shell_command',
            executionTime: 1,
            data: run.stdout,
            process: {
              command,
              directory: root,
              status: 'exited',
              exitCode: run.status,
              signal: null,
            },
          },
        },
        false,
      );
      expect(ledger.checks()[0].status).toBe('passed');
      await ledger.prepareSemanticReview();
      if (mode === 'modified-after-review')
        writeFileSync(file, "test('data value',()=>{});");
      expect(ledger.semanticChecks()[0].status).toBe(
        [
          'real-assertion',
          'throw-match',
          'async-return',
          'destructured',
        ].includes(mode)
          ? 'passed'
          : 'not_run',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
