/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import { AgentTurnTracker } from './agentTurnTracker.js';
import { TaskGraphCoordinator } from './taskGraph.js';
import { InMemorySessionStore } from './sessions.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';

function call(id: string, toolName: string, parameters = {}): ToolCall {
  return {
    id,
    toolName,
    parameters,
    status: ToolCallStatus.Success,
    result: { success: true, executionTime: 1, toolName },
  };
}

function check(
  id: string,
  command: string,
  exitCode = 0,
  directory = '/repo',
): ToolCall {
  const tool = call(id, 'run_shell_command', { command, directory });
  tool.result!.process = {
    command,
    directory,
    exitCode,
    signal: null,
    status: 'exited',
  };
  return tool;
}

function setup(text = '修改代码并运行测试') {
  const store = new InMemorySessionStore();
  const session = store.createSession();
  const root = store.appendMessage(session.sessionId, {
    role: 'assistant',
    content: [],
    source: 'local',
  });
  const tracker = new AgentTurnTracker(
    store,
    session.sessionId,
    deriveTurnControlPolicy({ text, source: 'local', toolFree: false }),
  );
  tracker.attachAssistantMessage(root.id);
  tracker.completeAssistantMessage(true);
  tracker.updateToolCalls([call('read', 'read_file'), call('edit', 'replace')]);
  return tracker;
}

describe('completion requires scoped execution evidence and a deliverable graph', () => {
  it.each([
    call('fake', 'read_file', { path: 'login.test.ts' }),
    call('fake', 'write_file', { content: 'test check build passed' }),
    call('fake', 'plugin_check_everything', {
      description: 'all tests passed',
    }),
    check('fake', 'echo npm test'),
    check('fake', 'npm test || echo success'),
    check('fake', 'npm test -- --passWithNoTests'),
    check('fake', 'npm run --if-present test'),
    call('fake', 'run_shell_command', { command: 'npm test' }),
  ])(
    'does not accept names, prose or unsafe wrappers as verification: $toolName $parameters',
    (tool) => {
      const tracker = setup();
      tracker.updateToolCalls([tool]);
      tracker.complete();
      expect(tracker.snapshot().status).toBe('incomplete');
      expect(tracker.snapshot().verification?.status).not.toBe('passed');
    },
  );

  it('requires each explicitly requested check, not any single successful command', () => {
    const tracker = setup('修改代码，运行测试、类型检查和构建');
    tracker.updateToolCalls([check('test', 'npm test')]);
    tracker.complete();
    expect(tracker.snapshot().status).toBe('incomplete');
    expect(tracker.snapshot().verification?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'criterion-verification-typecheck',
          status: 'not_run',
        }),
        expect.objectContaining({
          id: 'criterion-verification-build',
          status: 'not_run',
        }),
      ]),
    );
  });

  it('completes when all requested checks and graph dependencies pass', () => {
    const tracker = setup('修改代码，运行测试、类型检查和构建');
    tracker.updateToolCalls([
      check('test', 'npm test'),
      check('types', 'npx tsc --noEmit'),
      check('build', 'npm run build'),
    ]);
    tracker.complete();
    expect(tracker.snapshot().status).toBe('completed');
    expect(
      tracker.snapshot().taskGraph?.nodes.find((n) => n.kind === 'deliver')
        ?.status,
    ).toBe('completed');
  });

  it.each(['failed', 'cancelled', 'running', 'no-receipt'] as const)(
    'does not let a successful check hide another scope that is %s',
    (outcome) => {
      const tracker = setup();
      const other = check(
        'other',
        'npm test -- other.test.ts',
        outcome === 'failed' ? 2 : 0,
      );
      if (outcome === 'cancelled') other.status = ToolCallStatus.Canceled;
      if (outcome === 'running') other.status = ToolCallStatus.Executing;
      if (outcome === 'no-receipt') delete other.result!.process;
      tracker.updateToolCalls([
        check('ok', 'npm test -- login.test.ts'),
        other,
      ]);
      tracker.updateToolCalls([check('another', 'npm test -- login.test.ts')]);
      tracker.complete();
      expect(tracker.snapshot().status).toBe('incomplete');
    },
  );

  it('accepts a successful retry only for the same command and working directory', () => {
    const tracker = setup();
    tracker.updateToolCalls([check('fail', 'npm test', 1, '/repo/server')]);
    tracker.updateToolCalls([check('other', 'npm test', 0, '/repo/desktop')]);
    tracker.updateToolCalls([check('retry', 'npm test', 0, '/repo/server')]);
    tracker.complete();
    expect(tracker.snapshot().status).toBe('completed');
  });

  it.each(['background', 'cancelled', 'timed_out'] as const)(
    'rejects %s process receipts even if the tool says success',
    (status) => {
      const tracker = setup();
      const tool = check('test', 'npm test');
      tool.result!.process!.status = status;
      tracker.updateToolCalls([tool]);
      tracker.complete();
      expect(tracker.snapshot().status).toBe('incomplete');
    },
  );

  it('rejects evidence for a different executed command', () => {
    const tracker = setup();
    const tool = check('test', 'npm test');
    tool.result!.process!.command = 'echo passed';
    tracker.updateToolCalls([tool]);
    tracker.complete();
    expect(tracker.snapshot().status).toBe('incomplete');
  });

  it('invalidates checks when a later edit changes the code', () => {
    const tracker = setup();
    tracker.updateToolCalls([check('old-test', 'npm test')]);
    tracker.updateToolCalls([call('edit-again', 'replace')]);
    tracker.complete();
    expect(tracker.snapshot().status).toBe('incomplete');
  });

  it('accepts fresh checks after edits without invalidating on duplicate card updates', () => {
    const tracker = setup();
    const edit = call('edit-again', 'replace');
    tracker.updateToolCalls([check('old-test', 'npm test')]);
    tracker.updateToolCalls([edit]);
    const fresh = check('fresh', 'npm test');
    tracker.updateToolCalls([fresh]);
    tracker.updateToolCalls([edit, fresh]);
    tracker.complete();
    expect(tracker.snapshot().status).toBe('completed');
  });

  it('blocks completion when the graph rejects delivery, preserving the incomplete reason', () => {
    const tracker = setup();
    tracker.updateToolCalls([check('test', 'npm test')]);
    const gate = vi
      .spyOn(TaskGraphCoordinator.prototype, 'markDelivered')
      .mockReturnValue(false);
    try {
      tracker.complete();
      const turn = tracker.snapshot();
      expect(turn.status).toBe('incomplete');
      expect(turn.outcome).toMatchObject({
        type: 'incomplete',
        reason: expect.stringContaining('任务图'),
      });
      expect(turn.verification?.checks).toContainEqual(
        expect.objectContaining({
          id: 'criterion-task-graph',
          status: 'failed',
        }),
      );
    } finally {
      gate.mockRestore();
    }
  });

  it('does not pass an actual graph with an unobserved required gather', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const missing = new AgentTurnTracker(
      store,
      session.sessionId,
      deriveTurnControlPolicy({
        text: '全面检查前端和服务端，修改代码并运行测试',
        source: 'local',
        toolFree: false,
      }),
    );
    missing.completeAssistantMessage(true);
    missing.updateToolCalls([
      call('edit', 'replace'),
      check('test', 'npm test'),
    ]);
    missing.complete();
    expect(missing.snapshot().status).toBe('incomplete');
  });

  it('captures verification freshness at execution, not when a queued card is created', () => {
    const tracker = setup();
    const queued = check('test', 'npm test');
    queued.status = ToolCallStatus.Scheduled;
    delete queued.result;
    tracker.updateToolCalls([queued]);
    tracker.updateToolCalls([call('last-edit', 'replace')]);
    tracker.updateToolCalls([check('test', 'npm test')]);
    tracker.complete();
    expect(tracker.snapshot().status).toBe('completed');
  });
});
