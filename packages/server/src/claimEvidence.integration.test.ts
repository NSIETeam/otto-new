/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { AgentTurnTracker } from './agentTurnTracker.js';
import { InMemorySessionStore } from './sessions.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
import { ToolCallStatus } from './protocol.js';
describe('research delivery gate', () => {
  it('keeps an ordinary explanation free of review calls, disclaimers and report headings', () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const control = deriveTurnControlPolicy({
      text: '用一句话解释什么是递归',
      source: 'local',
      toolFree: false,
    });
    const tracker = new AgentTurnTracker(store, session.sessionId, control);
    const message = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    tracker.attachAssistantMessage(message.id);
    tracker.setDeliveryDraft(
      '递归就是把问题拆成同类的更小问题，直到达到可以直接解答的边界。',
    );
    tracker.completeAssistantMessage(true);
    expect(tracker.offersClaimReview()).toBe(false);
    tracker.complete();
    expect(tracker.snapshot().status).toBe('completed');
  });
  const setup = () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const control = deriveTurnControlPolicy({
      text: '研究最新产品情况并提供来源',
      source: 'local',
      toolFree: false,
    });
    control.evidenceRequirement = 'primary_sources';
    const tracker = new AgentTurnTracker(store, session.sessionId, control);
    const root = store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: [],
      source: 'local',
    });
    tracker.attachAssistantMessage(root.id);
    tracker.completeAssistantMessage(true);
    return tracker;
  };
  it('URL collection cannot complete researched claims', () => {
    const tracker = setup();
    tracker.updateToolCalls([
      {
        id: 's',
        toolName: 'web_search',
        parameters: {},
        status: ToolCallStatus.Success,
        result: {
          success: true,
          executionTime: 0,
          toolName: 'web_search',
          data: 'https://example.com',
        },
      },
    ]);
    tracker.setDeliveryDraft('已经证实全部事实。');
    tracker.complete();
    expect(tracker.snapshot().status).toBe('incomplete');
    expect(tracker.snapshot().citations?.every((c) => !c.verified)).toBe(true);
  });
  it('current original attribution can pass, then a modified draft cannot', () => {
    const tracker = setup();
    const text = 'The service is available.';
    const uri = 'https://example.com';
    tracker.updateToolCalls([
      {
        id: 'fetch',
        toolName: 'web_fetch',
        parameters: {},
        status: ToolCallStatus.Success,
        result: {
          success: true,
          executionTime: 0,
          toolName: 'web_fetch',
          sourceEvidence: [
            {
              uri,
              text,
              retrievedAt: new Date().toISOString(),
              sha256: createHash('sha256').update(text).digest('hex'),
              truncated: false,
            },
          ],
        },
      },
    ]);
    const draft = `该页记载：“${text}” [来源](${uri})`;
    tracker.reviewAnswerEvidence({
      requestRevision: 1,
      draft,
      claims: [
        {
          text: draft,
          kind: 'quotation',
          evidence: [{ sourceId: 'fetch:0', start: 0, end: text.length }],
        },
      ],
    });
    tracker.setDeliveryDraft(draft);
    expect(
      tracker
        .deliveryReadiness()
        .missing.filter((c) => c.id.startsWith('claim')),
    ).toEqual([]);
    tracker.setDeliveryDraft(draft + '\n利润一定翻倍。');
    expect(
      tracker
        .deliveryReadiness()
        .missing.some((c) => c.id.startsWith('claims:')),
    ).toBe(true);
  });
});
