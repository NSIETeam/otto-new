/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AgentTurnTracker } from './agentTurnTracker.js';
import {
  ToolCallStatus,
  type ServerToClient,
  type ToolCall,
} from './protocol.js';
import { InMemorySessionStore } from './sessions.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'todo-1',
    toolName: 'todo_write',
    parameters: {
      todos: [
        { id: 'a', content: '读取上下文', status: 'completed' },
        { id: 'b', content: '实现改进', status: 'in_progress' },
      ],
    },
    status: ToolCallStatus.Executing,
    ...overrides,
  };
}

describe('AgentTurnTracker', () => {
  it('emits ordered full snapshots and persists a completed turn on the root message', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const root = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [{ type: 'text', value: '' }],
      source: 'local',
      isStreaming: true,
    });
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (frame) => frames.push(frame));

    const tracker = new AgentTurnTracker(store, session.sessionId);
    tracker.attachAssistantMessage(root.id);
    tracker.markStreaming();
    tracker.completeAssistantMessage();
    tracker.updateToolCalls([tool()]);
    tracker.updateToolCalls([
      tool({
        status: ToolCallStatus.Success,
        parameters: {
          todos: [
            { id: 'a', content: '读取上下文', status: 'completed' },
            { id: 'b', content: '实现改进', status: 'completed' },
          ],
        },
      }),
    ]);
    tracker.attachAssistantMessage('follow-up-message');
    tracker.complete();

    const events = frames.filter(
      (frame): frame is Extract<ServerToClient, { type: 'turn_event' }> =>
        frame.type === 'turn_event',
    );
    expect(events[0]?.payload.event).toBe('turn_started');
    expect(events.at(-1)?.payload.event).toBe('turn_completed');
    expect(events.map((event) => event.payload.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(
      events.every(
        (event) => event.payload.snapshot.sequence === event.payload.sequence,
      ),
    ).toBe(true);
    expect(
      events.every((event) => event.payload.snapshot.turnId === tracker.turnId),
    ).toBe(true);

    const persisted = store
      .getHistory(session.sessionId)
      .find((message) => message.id === root.id);
    expect(persisted?.turn?.status).toBe('completed');
    expect(persisted?.turn?.control?.intent).toBe('answer');
    expect(persisted?.turn?.lineage).toMatchObject({
      runId: tracker.turnId,
      attempt: 1,
    });
    expect(persisted?.turn?.outcome).toEqual({ type: 'success' });
    expect(
      persisted?.turn?.items.some((item) => item.type === 'tool_group'),
    ).toBe(true);
    const plan = persisted?.turn?.items.find((item) => item.type === 'plan');
    expect(
      plan?.type === 'plan' &&
        plan.steps.every((step) => step.status === 'completed'),
    ).toBe(true);
  });

  it('records cancellation and failures as explicit terminal outcomes', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const cancelledMessage = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    const cancelled = new AgentTurnTracker(store, session.sessionId);
    cancelled.attachAssistantMessage(cancelledMessage.id);
    cancelled.cancel();
    expect(store.getHistory(session.sessionId).at(-1)?.turn?.status).toBe(
      'cancelled',
    );

    const failedMessage = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    const failed = new AgentTurnTracker(store, session.sessionId);
    failed.attachAssistantMessage(failedMessage.id);
    failed.fail('模型连接失败');
    const failure = store.getHistory(session.sessionId).at(-1)?.turn;
    expect(failure?.status).toBe('failed');
    expect(failure?.items).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        level: 'error',
        detail: '模型连接失败',
      }),
    );
  });

  it('marks research without source evidence as incomplete instead of claiming success', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const root = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    const policy = deriveTurnControlPolicy({
      text: '查找最新政策并核实官方来源',
      source: 'local',
      toolFree: false,
    });
    const tracker = new AgentTurnTracker(store, session.sessionId, policy);
    tracker.attachAssistantMessage(root.id);
    tracker.completeAssistantMessage(true);
    tracker.complete();

    const turn = store.getHistory(session.sessionId).at(-1)?.turn;
    expect(turn?.status).toBe('incomplete');
    expect(turn?.verification?.status).toBe('partial');
    expect(turn?.outcome).toMatchObject({ type: 'incomplete' });
    expect(turn?.items).toContainEqual(
      expect.objectContaining({
        type: 'verification',
        status: 'failed',
      }),
    );
  });

  it('completes a change only after mutation and explicit verification results', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const root = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    const policy = deriveTurnControlPolicy({
      text: '修改登录代码并运行测试',
      source: 'local',
      toolFree: false,
    });
    const tracker = new AgentTurnTracker(store, session.sessionId, policy);
    tracker.attachAssistantMessage(root.id);
    tracker.updateToolCalls([
      tool({
        id: 'edit-1',
        toolName: 'replace',
        parameters: { path: 'login.ts' },
        status: ToolCallStatus.Success,
        result: { success: true, executionTime: 4 },
      }),
      tool({
        id: 'test-1',
        toolName: 'run_shell_command',
        parameters: { command: 'npm test' },
        status: ToolCallStatus.Success,
        result: { success: true, executionTime: 8 },
      }),
    ]);
    tracker.completeAssistantMessage(true);
    tracker.complete();

    const turn = store.getHistory(session.sessionId).at(-1)?.turn;
    expect(turn?.status).toBe('completed');
    expect(turn?.verification?.status).toBe('passed');
    expect(
      turn?.verification?.checks.every((check) => check.status === 'passed'),
    ).toBe(true);
  });

  it('records an unknown model outcome as a resumable reconciliation boundary', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const root = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    const tracker = new AgentTurnTracker(store, session.sessionId);
    tracker.attachAssistantMessage(root.id);
    tracker.interruptUnknown('供应商可能已接收请求');

    const turn = store.getHistory(session.sessionId).at(-1)?.turn;
    expect(turn?.status).toBe('interrupted');
    expect(turn?.outcome).toMatchObject({
      type: 'unknown_outcome',
      requiresReconciliation: true,
    });
    expect(turn?.retries).toEqual([
      expect.objectContaining({ outcome: 'unknown_outcome', attempt: 1 }),
    ]);
  });

  it('automatically registers sanitized citations and verifies generated artifacts', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const root = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    const policy = deriveTurnControlPolicy({
      text: '查找官方资料并生成一份 PDF 报告',
      source: 'local',
      toolFree: false,
    });
    const tracker = new AgentTurnTracker(store, session.sessionId, policy);
    tracker.attachAssistantMessage(root.id);
    tracker.updateToolCalls([
      tool({
        id: 'search-1',
        toolName: 'web_search',
        parameters: { query: '官方资料' },
        status: ToolCallStatus.Success,
        result: {
          success: true,
          data: '官方来源：https://example.com/report?token=private-value',
          executionTime: 2,
          toolName: 'web_search',
        },
      }),
      tool({
        id: 'write-1',
        toolName: 'write_document',
        parameters: { outputPath: 'D:\\reports\\园区分析.pdf' },
        status: ToolCallStatus.Success,
        result: {
          success: true,
          data: '已写入 D:\\reports\\园区分析.pdf',
          executionTime: 3,
          toolName: 'write_document',
        },
      }),
    ]);

    let snapshot = tracker.snapshot();
    expect(snapshot.citations).toEqual([
      expect.objectContaining({
        uri: expect.stringContaining('example.com/report'),
        sourceType: 'web',
        verified: true,
      }),
    ]);
    expect(JSON.stringify(snapshot.citations)).not.toContain('private-value');
    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({
        label: '园区分析.pdf',
        path: 'D:\\reports\\园区分析.pdf',
        mimeType: 'application/pdf',
        verified: false,
      }),
    ]);

    tracker.updateToolCalls([
      tool({
        id: 'verify-1',
        toolName: 'verify_output',
        parameters: { path: 'D:\\reports\\园区分析.pdf' },
        status: ToolCallStatus.Success,
        result: {
          success: true,
          data: 'PDF 可读取且页数正确',
          executionTime: 4,
          toolName: 'verify_output',
        },
      }),
    ]);
    snapshot = tracker.snapshot();
    expect(snapshot.artifacts[0]?.verified).toBe(true);
  });

  it('preserves a home-relative PPT path instead of truncating it to /Desktop', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const root = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    const tracker = new AgentTurnTracker(store, session.sessionId);
    tracker.attachAssistantMessage(root.id);
    tracker.updateToolCalls([
      tool({
        id: 'ppt-1',
        toolName: 'generate_presentation',
        parameters: {
          outputPath: '~/Desktop/apple-flywheel/苹果公司介绍.pptx',
        },
        status: ToolCallStatus.Success,
        result: {
          success: true,
          data: '已生成 ~/Desktop/apple-flywheel/苹果公司介绍.pptx',
          executionTime: 3,
          toolName: 'generate_presentation',
        },
      }),
    ]);

    expect(tracker.snapshot().artifacts).toEqual([
      expect.objectContaining({
        label: '苹果公司介绍.pptx',
        path: '~/Desktop/apple-flywheel/苹果公司介绍.pptx',
      }),
    ]);
  });
});
