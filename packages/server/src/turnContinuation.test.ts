/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { resolveTurnRequest } from './turnContinuation.js';
import { AgentTurnTracker } from './agentTurnTracker.js';
import { InMemorySessionStore } from './sessions.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
import { TaskContractLedger } from './taskContract.js';
import { ToolCallStatus, type OttoMessage } from './protocol.js';

const task = '修复登录并运行测试';
function previous(text = task) {
  const store = new InMemorySessionStore();
  const session = store.createSession({ workspacePath: '/repo' });
  store.appendMessage(session.sessionId, {
    role: 'user',
    source: 'local',
    content: [{ type: 'text', value: text }],
  });
  const root = store.appendMessage(session.sessionId, {
    role: 'assistant',
    source: 'local',
    content: [],
  });
  const tracker = new AgentTurnTracker(
    store,
    session.sessionId,
    deriveTurnControlPolicy({ text, source: 'local', toolFree: false }),
    { taskText: text },
  );
  tracker.attachAssistantMessage(root.id);
  tracker.fail('测试未完成');
  return store.getHistory(session.sessionId);
}
const resolve = (
  text: string,
  history: OttoMessage[] = previous(),
  extra = {},
) =>
  resolveTurnRequest({
    text,
    history,
    source: 'local',
    workspacePath: '/repo',
    ...extra,
  });

describe('native cross-turn request continuity', () => {
  it.each([
    '继续',
    '继续下一步。',
    '照刚才说的做',
    '照办',
    '把这个弄好',
    '让它能用就行',
    'go ahead',
  ])('inherits the actual user request for %s', (text) => {
    const result = resolve(text);
    expect(result.kind).toBe('continued');
    expect(result.request.text).toBe(task);
    expect(result.request.continuedFromTurnId).toBeTruthy();
  });

  it.each([
    '你好',
    '不要继续了，取消原任务',
    '换个话题，讲个故事',
    '“继续”是什么意思？',
    '继续是什么意思',
    '继续修复支付模块并测试',
  ])('does not reinterpret a substantive new request: %s', (text) => {
    expect(resolve(text).kind).toBe('fresh');
    expect(resolve(text).request.text).toBe(text);
  });

  it.each(['继续，但不用测试了', '继续，换到另一个项目', '同意', '授权'])(
    'does not infer an acceptance change or tool approval: %s',
    (text) => {
      expect(resolve(text).kind).toBe('clarify');
    },
  );

  it('does not use assistant suggestions, stale topics or missing context as authority', () => {
    expect(resolve('继续', []).kind).toBe('clarify');
    expect(
      resolve(
        '继续',
        previous().filter((m) => m.role !== 'user'),
      ).kind,
    ).toBe('clarify');
    const history = previous();
    history.push({
      ...history[0],
      id: 'new-topic',
      content: [{ type: 'text', value: '取消原任务' }],
    });
    expect(resolve('继续', history).kind).toBe('clarify');
    history.push({
      ...history[1],
      id: 'suggestion',
      turn: undefined,
      content: [{ type: 'text', value: '建议部署到生产服务器' }],
    });
    expect(resolve('继续', history).kind).toBe('clarify');
  });

  it('uses the server-selected user message boundary, excluding retrieval context', () => {
    const history = previous();
    history.push({
      ...history[0],
      id: 'current',
      content: [{ type: 'text', value: '继续' }],
    });
    expect(
      resolve('继续', history, { currentUserMessageId: 'current' }).request
        .text,
    ).toBe(task);
    expect(
      resolve('继续', history, { currentUserMessageId: 'missing' }).kind,
    ).toBe('clarify');
    expect(
      resolve('修复登录', history, { currentUserMessageId: 'missing' }).kind,
    ).toBe('clarify');
    expect(resolve('继续', previous('继续。')).kind).toBe('clarify');
  });

  it('fails closed on changed source, changed workspace, or unknown tool outcomes', () => {
    const history = previous();
    history[1].turn!.request = {
      version: 1,
      text: task,
      source: 'local',
      workspacePath: '/original',
    };
    expect(resolve('继续', history).kind).toBe('clarify');
    expect(resolve('继续', previous(), { source: 'feishu' }).kind).toBe(
      'clarify',
    );
    const unknown = previous();
    unknown[1].turn!.outcome = {
      type: 'unknown_outcome',
      reason: 'receipt lost',
      requiresReconciliation: true,
    };
    expect(resolve('继续', unknown).kind).toBe('clarify');
    const pending = previous();
    pending[1].associatedToolCalls = [
      {
        id: 'pending',
        toolName: 'run_shell_command',
        parameters: { command: 'deploy' },
        status: ToolCallStatus.Executing,
      },
    ];
    expect(resolve('继续', pending).kind).toBe('clarify');
  });

  it('does not replay a completed action or an external operation', () => {
    const history = previous();
    history[1].turn!.status = 'completed';
    history[1].turn!.verification!.status = 'passed';
    expect(resolve('继续', history).kind).toBe('clarify');
    expect(resolve('继续', previous('部署到生产服务器')).kind).toBe('clarify');
    // Older false completions must not erase the source request's verification.
    history[1].turn!.verification!.status = 'not_required';
    expect(resolve('继续', history).kind).toBe('continued');
  });

  it('carries acceptance definitions, but no previous evidence or graph completion', () => {
    const history = previous();
    const contract = new TaskContractLedger(task);
    contract.update({
      expectedRevision: 0,
      objectives: [
        {
          id: 'login',
          sourceQuote: task,
          description: task,
          dependsOn: [],
          criteria: [
            {
              id: 'check',
              description: '登录正常场景',
              kind: 'process',
              command: 'npm test',
              directory: '/repo',
              requirementQuote: '修复登录',
              testCase: { name: 'login normal', scenario: 'normal' },
            },
          ],
          evidence: [],
        },
      ],
    });
    const snapshot = contract.snapshot();
    snapshot.objectives[0].evidence = [
      { criterionId: 'check', toolCallId: 'old-passed-tool' },
    ];
    history[1].turn!.taskGraph!.taskContract = snapshot;
    const result = resolve('继续', history);
    expect(result.kind).toBe('continued');
    if (result.kind !== 'continued') throw new Error('expected continuation');
    expect(result.contract!.objectives[0].criteria).toEqual(
      snapshot.objectives[0].criteria,
    );
    expect(result.contract!.objectives[0].evidence).toEqual([]);
    expect(snapshot.objectives[0].evidence).toHaveLength(1);
    result.contract!.objectives[0].criteria[0].description = 'mutated';
    expect(snapshot.objectives[0].criteria[0].description).toBe('登录正常场景');
  });

  it('rejects corrupt acceptance instead of discarding it and weakening the gate', () => {
    const history = previous();
    history[1].turn!.taskGraph!.taskContract = {
      version: 1,
      revision: 0,
      objectives: [],
    };
    expect(resolve('继续', history).kind).toBe('clarify');
  });

  it('does not truncate oversized original requirements', () => {
    expect(resolve('继续', previous(task + 'x'.repeat(40_000))).kind).toBe(
      'clarify',
    );
  });

  it('keeps duplicate behaviors in distinct modules and required edge cases across turns', () => {
    const request =
      '| 模块 | 要求 |\n| --- | --- |\n| 登录 | 支持重试，网络异常后可恢复 |\n| 支付 | 支持重试，重复提交不得扣两次 |';
    const result = resolve('继续', previous(request));
    expect(result.request.text).toBe(request);
    const requirements = new TaskContractLedger(
      result.request.text,
    ).requirements();
    expect(
      requirements.some(
        (r) => r.quote.includes('登录') && r.quote.includes('支持重试'),
      ),
    ).toBe(true);
    expect(
      requirements.some(
        (r) => r.quote.includes('支付') && r.quote.includes('支持重试'),
      ),
    ).toBe(true);
  });
});
