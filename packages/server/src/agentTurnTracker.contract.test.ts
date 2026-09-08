/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { AgentTurnTracker } from './agentTurnTracker.js';
import { InMemorySessionStore } from './sessions.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';
import { resolveTurnRequest } from './turnContinuation.js';
import { receiptTestFixture } from '../test-utils/semanticFixtures.js';
import path from 'node:path';
import { toolExecutionFingerprint } from './turnRecoveryStore.js';
import { writeFileSync } from 'node:fs';

describe('task acceptance is part of runtime completion and recovery', () => {
  it.each([
    [false, false, 'none'],
    [true, false, 'none'],
    [true, true, 'none'],
    [false, true, 'none'],
    [true, true, 'permission'],
    [true, true, 'reconcile'],
    [true, true, 'stale'],
    [true, true, 'weak'],
  ])(
    'only completes with evidence %s; broken runner replaced %s; guard %s',
    async (attachEvidence, replaceRunner, guard) => {
      const testSource = receiptTestFixture([
        'login normal',
        'runner executes',
      ]);
      if (guard === 'weak')
        writeFileSync(
          testSource,
          "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('login normal',()=>assert.equal(1,1)); test('runner executes',()=>assert.equal(1,1));",
        );
      const store = new InMemorySessionStore();
      const session = store.createSession();
      const root = store.appendMessage(session.sessionId, {
        role: 'assistant',
        content: [],
        source: 'local',
      });
      const taskText = '修复登录并运行测试';
      const policy = deriveTurnControlPolicy({
        text: taskText,
        source: 'local',
        toolFree: false,
      });
      const tracker = new AgentTurnTracker(store, session.sessionId, policy, {
        taskText,
      });
      tracker.attachAssistantMessage(root.id);
      const objective = {
        id: 'login',
        description: '登录修复',
        sourceQuote: taskText,
        dependsOn: [],
        criteria: [
          {
            id: 'regression',
            description: '登录回归',
            kind: 'process',
            command: 'npm test',
            directory: '/repo',
            requirementQuote: '修复登录',
            testCase: { name: 'login normal', scenario: 'normal' },
            inputFiles: [testSource],
          },
          {
            id: 'run-tests',
            description: '执行要求的测试',
            kind: 'process',
            command: 'npm test',
            directory: '/repo',
            requirementQuote: '运行测试',
            testCase: { name: 'runner executes', scenario: 'normal' },
            inputFiles: [testSource],
          },
        ],
        evidence: [],
      };
      tracker.updateTaskContract({
        expectedRevision: 0,
        objectives: [objective],
      });
      const tool = (id: string, toolName: string): ToolCall => ({
        id,
        toolName,
        parameters: {},
        status: ToolCallStatus.Success,
        result: { success: true, toolName, executionTime: 1 },
      });
      const check = tool('test', 'run_shell_command');
      check.parameters = { command: 'npm test', directory: '/repo' };
      check.result!.data =
        'TAP version 13\nok 1 - login normal\nok 2 - runner executes\n1..2\n';
      check.result!.process = {
        command: 'npm test',
        directory: '/repo',
        status: 'exited',
        exitCode: 0,
        signal: null,
      };
      tracker.updateToolCalls([tool('read', 'read_file')]);
      tracker.updateToolCalls([
        {
          ...tool('read-test-source', 'read_file'),
          parameters: { file_path: testSource },
        },
      ]);
      tracker.updateToolCalls([tool('write', 'replace')]);
      if (replaceRunner) {
        const broken = structuredClone(check);
        broken.id = 'broken';
        broken.status = ToolCallStatus.Error;
        broken.result!.success = false;
        broken.result!.error = 'Missing script: test';
        broken.result!.process!.exitCode = 1;
        broken.result!.data = '';
        tracker.updateToolCalls([broken]);
        tracker.recordAdaptation({
          category:
            guard === 'permission'
              ? 'permission'
              : guard === 'reconcile'
                ? 'unknown_side_effect'
                : 'not_found',
          action:
            guard === 'permission'
              ? 'request_input'
              : guard === 'reconcile'
                ? 'reconcile'
                : 'switch_strategy',
          toolName: 'run_shell_command',
          attempt: 1,
          failedToolCallId: broken.id,
          failureFingerprint: toolExecutionFingerprint(
            broken.toolName,
            broken.parameters,
          ),
        });
        check.parameters.command = 'npx vitest run';
        check.result!.process!.command = 'npx vitest run';
      }
      tracker.updateToolCalls([check]);
      if (attachEvidence)
        tracker.updateTaskContract({
          expectedRevision: 1,
          revisionReason: '原检查脚本缺失，使用相同用例的替代命令',
          objectives: [
            {
              ...objective,
              criteria: objective.criteria.map((c) => ({
                ...c,
                command: replaceRunner ? 'npx vitest run' : c.command,
              })),
              evidence: objective.criteria.map((c) => ({
                criterionId: c.id,
                toolCallId: 'test',
              })),
            },
          ],
        });
      if (guard === 'stale')
        writeFileSync(testSource, 'changed after the passing receipt');
      tracker.completeAssistantMessage(true);
      await tracker.prepareDeliveryEvidence();
      tracker.complete();
      expect(
        tracker.snapshot().status,
        JSON.stringify(tracker.deliveryReadiness().missing),
      ).toBe(attachEvidence && guard === 'none' ? 'completed' : 'incomplete');
      expect(
        tracker.snapshot().taskGraph?.taskContract?.objectives,
      ).toHaveLength(1);
      if (guard === 'none')
        expect(
          tracker
            .snapshot()
            .taskGraph?.nodes.find((node) => node.id === 'objective-login')
            ?.status,
        ).toBe(attachEvidence ? 'completed' : 'pending');
      if (replaceRunner && (!attachEvidence || guard !== 'none'))
        expect(
          tracker
            .snapshot()
            .taskGraph?.nodes.filter((n) => n.id.startsWith('graph-recover-'))
            .some((n) => n.status !== 'completed'),
        ).toBe(true);
      if (attachEvidence && !replaceRunner) {
        // Simulate an unfinished delivery with some old successful checks.
        store.patchMessage(session.sessionId, root.id, {
          turn: {
            ...tracker.snapshot(),
            status: 'incomplete',
            request: {
              version: 1,
              text: taskText,
              source: 'local',
              workspacePath: path.dirname(testSource),
            },
          },
        });
        const resolution = resolveTurnRequest({
          text: '继续',
          source: 'local',
          workspacePath: path.dirname(testSource),
          history: store.getHistory(session.sessionId),
        });
        expect(resolution.kind).toBe('continued');
        if (resolution.kind !== 'continued')
          throw new Error('expected continuation');
        const next = new AgentTurnTracker(store, session.sessionId, policy, {
          taskText: resolution.request.text,
          request: resolution.request,
          taskContractSnapshot: resolution.contract,
        });
        expect(next.deliveryReadiness().missing.length).toBeGreaterThan(0);
        expect(
          next.taskGraphSnapshot().taskContract!.objectives[0].evidence,
        ).toEqual([]);
        expect(() =>
          next.updateTaskContract({
            expectedRevision: 2,
            objectives: [
              { ...objective, criteria: objective.criteria.slice(0, 1) },
            ],
          }),
        ).toThrow();
        // Even deliberately rebinding an old call id is not native evidence.
        next.updateTaskContract({
          expectedRevision: 2,
          objectives: [
            {
              ...objective,
              evidence: objective.criteria.map((c) => ({
                criterionId: c.id,
                toolCallId: 'test',
              })),
            },
          ],
        });
        expect(next.deliveryReadiness().missing.length).toBeGreaterThan(0);
        next.updateToolCalls([tool('fresh-read', 'read_file')]);
        next.updateToolCalls([tool('fresh-write', 'replace')]);
        next.updateToolCalls([{ ...check, id: 'fresh-test' }]);
        next.updateTaskContract({
          expectedRevision: 3,
          objectives: [
            {
              ...objective,
              evidence: objective.criteria.map((c) => ({
                criterionId: c.id,
                toolCallId: 'fresh-test',
              })),
            },
          ],
        });
        next.completeAssistantMessage(true);
        await next.prepareDeliveryEvidence();
        next.complete();
        expect(next.snapshot().status).toBe('completed');
        expect(
          next
            .snapshot()
            .verification?.checks.find(
              (c) => c.id === 'objective:login:regression',
            )?.status,
        ).toBe('passed');
      }
    },
  );
});
