/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { AgentTurnTracker } from './agentTurnTracker.js';
import { InMemorySessionStore } from './sessions.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';

describe('task acceptance is part of runtime completion and recovery', () => {
  it.each([false, true])(
    'only completes after objective evidence is attached: %s',
    (attachEvidence) => {
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
        sourceQuote: '修复登录',
        dependsOn: [],
        criteria: [
          {
            id: 'regression',
            description: '登录回归',
            kind: 'process',
            command: 'npm test',
            directory: '/repo',
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
      check.result!.process = {
        command: 'npm test',
        directory: '/repo',
        status: 'exited',
        exitCode: 0,
        signal: null,
      };
      tracker.updateToolCalls([tool('read', 'read_file')]);
      tracker.updateToolCalls([tool('write', 'replace')]);
      tracker.updateToolCalls([check]);
      if (attachEvidence)
        tracker.updateTaskContract({
          expectedRevision: 1,
          objectives: [
            {
              ...objective,
              evidence: [{ criterionId: 'regression', toolCallId: 'test' }],
            },
          ],
        });
      tracker.completeAssistantMessage(true);
      tracker.complete();
      expect(tracker.snapshot().status).toBe(
        attachEvidence ? 'completed' : 'incomplete',
      );
      expect(
        tracker.snapshot().taskGraph?.taskContract?.objectives,
      ).toHaveLength(1);
      expect(
        tracker
          .snapshot()
          .taskGraph?.nodes.find((node) => node.id === 'objective-login')
          ?.status,
      ).toBe(attachEvidence ? 'completed' : 'pending');
    },
  );
});
