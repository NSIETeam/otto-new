/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentTurnTracker } from './agentTurnTracker.js';
import { TaskContractLedger } from './taskContract.js';
import { InMemorySessionStore } from './sessions.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';

const directories: string[] = [];
function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-stage2-'));
  directories.push(dir);
  return dir;
}
afterEach(() =>
  directories
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
function call(id: string, toolName: string, parameters = {}): ToolCall {
  return {
    id,
    toolName,
    parameters,
    status: ToolCallStatus.Success,
    result: { toolName, success: true, executionTime: 1 },
  };
}
function tracker(text = '生成文件') {
  const store = new InMemorySessionStore();
  const session = store.createSession();
  const instance = new AgentTurnTracker(
    store,
    session.sessionId,
    deriveTurnControlPolicy({ text, source: 'local', toolFree: false }),
  );
  instance.completeAssistantMessage(true);
  return instance;
}
function testCall(id: string): ToolCall {
  const tool = call(id, 'run_shell_command', {
    command: 'npm test',
    directory: '/repo',
  });
  tool.result!.process = {
    command: 'npm test',
    directory: '/repo',
    exitCode: 0,
    signal: null,
    status: 'exited',
  };
  tool.result!.data = 'TAP version 13\nok 1 - login works\n1..1\n';
  return tool;
}
function ledger() {
  const instance = new TaskContractLedger('修复登录');
  instance.update({
    expectedRevision: 0,
    objectives: [
      {
        id: 'login',
        description: '登录',
        sourceQuote: '修复登录',
        dependsOn: [],
        criteria: [
          {
            id: 'case',
            kind: 'process',
            description: '正常登录',
            command: 'npm test',
            directory: '/repo',
            testCase: { name: 'login works', scenario: 'normal' },
          },
        ],
        evidence: [{ criterionId: 'case', toolCallId: 'test' }],
      },
    ],
  });
  return instance;
}

describe('stage 2 delivery evidence regressions', () => {
  it.each([
    'missing-second',
    'old-file',
    'fresh',
    'stale-content-test',
    'missing-pdf',
  ] as const)(
    'requires each requested file and its current content test: %s',
    async (mode) => {
      const dir = workspace();
      const one = path.join(dir, 'one.json');
      const two = path.join(dir, 'two.json');
      const testSource = path.join(dir, 'contents.test.cjs');
      writeFileSync(testSource, `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('login works',()=>{assert.deepEqual(JSON.parse(fs.readFileSync(${JSON.stringify(one)},'utf8')),{data:1});assert.deepEqual(JSON.parse(fs.readFileSync(${JSON.stringify(two)},'utf8')),{data:1})});`);
      const prompt =
        mode === 'missing-pdf'
          ? '生成 `one.json` 和 PDF'
          : '生成 `one.json` 和 `two.json`';
      const store = new InMemorySessionStore();
      const session = store.createSession({ workspacePath: dir });
      const turn = new AgentTurnTracker(
        store,
        session.sessionId,
        deriveTurnControlPolicy({
          text: prompt,
          source: 'local',
          toolFree: false,
        }),
        {
          taskText: prompt,
          request: {
            version: 1,
            text: prompt,
            source: 'local',
            workspacePath: dir,
          },
        },
      );
      const objective = {
        id: 'files',
        description: '两份数据文件',
        sourceQuote: prompt,
        dependsOn: [],
        criteria: [
          {
            id: 'one',
            kind: 'artifact',
            description: '第一份文件',
            artifactPath: one,
            requirementQuote: prompt,
          },
          ...(mode === 'missing-second'
            ? []
            : [
                {
                  id: 'two',
                  kind: 'artifact',
                  description: '第二份文件',
                  artifactPath: two,
                  requirementQuote: prompt,
                },
              ]),
          {
            id: 'contents',
            kind: 'process',
            command: 'npm test',
            directory: dir,
            description: '校验两份数据',
            requirementQuote: prompt,
            inputFiles: [one, two, testSource],
            testCase: { name: 'login works', scenario: 'normal' },
          },
        ],
        evidence: [
          { criterionId: 'one', toolCallId: 'one' },
          ...(mode === 'missing-second'
            ? []
            : [{ criterionId: 'two', toolCallId: 'two' }]),
          { criterionId: 'contents', toolCallId: 'test' },
        ],
      };
      turn.updateTaskContract({ expectedRevision: 0, objectives: [objective] });
      turn.updateToolCalls([call('read-context', 'read_file')]);
      for (const [id, file] of [
        ['one', one],
        ['two', two],
      ]) {
        if (mode === 'old-file') writeFileSync(file, '{"data":1}');
        const write = call(id, 'write_file', { file_path: file });
        turn.updateToolCalls([
          { ...write, status: ToolCallStatus.Executing, result: undefined },
        ]);
        writeFileSync(file, '{"data":1}');
        turn.updateToolCalls([write]);
      }
      const test = testCall('test');
      test.parameters.directory = dir;
      test.result!.process!.directory = dir;
      turn.updateToolCalls([test]);
      if (mode === 'stale-content-test') writeFileSync(two, '{"data":2}');
      turn.completeAssistantMessage(true);
      await turn.prepareDeliveryEvidence();
      turn.complete();
      expect(
        turn.snapshot().status,
        JSON.stringify(turn.snapshot().verification),
      ).toBe(mode === 'fresh' ? 'completed' : 'incomplete');
      if (mode === 'fresh')
        expect(
          turn
            .snapshot()
            .verification?.checks.find(
              (c) => c.id === 'objective:files:contents',
            )?.receiptBinding?.inputVersions,
        ).toHaveLength(3);
    },
  );
  it('snapshot consumers cannot mutate native artifact version receipts', () => {
    const file = path.join(workspace(), 'result.json');
    writeFileSync(file, '{"value":1}');
    const turn = tracker();
    turn.updateToolCalls([call('write', 'write_file', { file_path: file })]);
    const snapshot = turn.snapshot();
    snapshot.artifacts![0].verification!.version!.sha256 = 'forged';
    expect(
      turn.snapshot().artifacts![0].verification!.version!.sha256,
    ).not.toBe('forged');
  });
  it('one good file cannot hide another missing deliverable', () => {
    const dir = workspace();
    const good = path.join(dir, 'good.json');
    writeFileSync(good, '{"ok":true}');
    const turn = tracker();
    turn.updateToolCalls([
      call('good', 'write_file', { file_path: good }),
      call('missing', 'write_file', {
        file_path: path.join(dir, 'missing.json'),
      }),
    ]);
    expect(turn.deliveryReadiness().missing).toContainEqual(
      expect.objectContaining({ id: 'criterion-artifact' }),
    );
  });
  it.each([
    ['invalid.json', '{"broken":'],
    ['fake.pptx', 'PK\x03\x04ppt/presentation.xml'],
    ['fake.pdf', '%PDF-1.7\ntruncated'],
  ])(
    'does not accept a signature without a readable format: %s',
    (name, content) => {
      const file = path.join(workspace(), name);
      writeFileSync(file, content);
      const turn = tracker();
      turn.updateToolCalls([call('write', 'write_file', { file_path: file })]);
      expect(turn.deliveryReadiness().missing).toContainEqual(
        expect.objectContaining({ id: 'criterion-artifact' }),
      );
      expect(turn.snapshot().artifacts?.[0]?.verified).toBe(false);
    },
  );
  it('does not trust a verified boolean without a native inspection receipt', () => {
    const turn = tracker();
    turn.recordArtifact({
      id: 'claimed',
      label: 'claimed.json',
      path: '/missing/claimed.json',
      verified: true,
    });
    expect(turn.deliveryReadiness().missing).toContainEqual(
      expect.objectContaining({ id: 'criterion-artifact' }),
    );
  });
  it('invalidates a same-size valid artifact changed after its native receipt', () => {
    const file = path.join(workspace(), 'result.json');
    writeFileSync(file, '{"value":1}');
    const turn = tracker();
    turn.updateToolCalls([call('write', 'write_file', { file_path: file })]);
    expect(turn.snapshot().artifacts?.[0]?.verified).toBe(true);
    writeFileSync(file, '{"value":2}');
    expect(turn.deliveryReadiness().missing).toContainEqual(
      expect.objectContaining({ id: 'criterion-artifact' }),
    );
    // Repeated UI cards cannot silently rebind validation to the changed bytes.
    turn.updateToolCalls([call('write', 'write_file', { file_path: file })]);
    expect(turn.deliveryReadiness().missing).toContainEqual(
      expect.objectContaining({ id: 'criterion-artifact' }),
    );
  });
  it('a progress message is not a final answer', () => {
    const turn = tracker('解释这段代码');
    turn.completeAssistantMessage(false);
    expect(turn.deliveryReadiness().missing).toContainEqual(
      expect.objectContaining({ id: 'criterion-answer' }),
    );
  });
  it('a successful mutation cannot hide an unrelated failed mutation', () => {
    const turn = tracker('修改代码并运行测试');
    const failed = call('fail', 'replace');
    failed.status = ToolCallStatus.Error;
    failed.result!.success = false;
    turn.updateToolCalls([
      call('read', 'read_file'),
      failed,
      call('ok', 'write_file'),
      testCall('test'),
    ]);
    expect(turn.deliveryReadiness().missing).toContainEqual(
      expect.objectContaining({ id: 'criterion-change' }),
    );
  });
  it('a successful external receipt does not hide a different failed operation', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const turn = new AgentTurnTracker(store, session.sessionId, {
      ...deriveTurnControlPolicy({
        text: '发送消息',
        source: 'local',
        toolFree: false,
      }),
      confirmationMode: 'policy',
      successCriteria: [
        { id: 'criterion-receipt', kind: 'receipt', label: '逐项操作回执' },
      ],
    });
    const failed = call('failed', 'send_message', { recipient: 'one' });
    failed.status = ToolCallStatus.Error;
    failed.result!.success = false;
    turn.updateToolCalls([
      failed,
      call('ok', 'send_message', { recipient: 'two' }),
    ]);
    expect(turn.deliveryReadiness().missing).toContainEqual(
      expect.objectContaining({ id: 'criterion-receipt' }),
    );
  });
  it('a test started during a write is stale when that write finishes', () => {
    const contract = ledger();
    const edit = call('write', 'replace');
    contract.observe(
      { ...edit, status: ToolCallStatus.Executing, result: undefined },
      true,
    );
    contract.observe(testCall('test'), false);
    contract.observe(edit, true);
    expect(contract.checks()[0].status).not.toBe('passed');
  });
  it('out-of-band changes to observed input bytes invalidate successful tests', () => {
    const file = path.join(workspace(), 'login.ts');
    writeFileSync(file, 'version1');
    const contract = ledger();
    contract.observe(call('read', 'read_file', { absolute_path: file }), false);
    contract.observe(testCall('test'), false);
    expect(contract.checks()[0].status).toBe('passed');
    writeFileSync(file, 'version2');
    expect(contract.checks()[0].status).not.toBe('passed');
  });
});
