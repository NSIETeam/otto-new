/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AgentTurnSnapshot, OttoMessage } from 'otto-server';
import {
  applyAgentTurnEvent,
  type AgentTurnEventPayload,
} from './agentTurnState.js';

function message(): OttoMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'assistant',
    content: [],
    timestamp: 1,
    source: 'local',
  };
}

function snapshot(
  sequence: number,
  status: AgentTurnSnapshot['status'],
  updatedAt = sequence,
): AgentTurnSnapshot {
  return {
    contractVersion: 1,
    turnId: 't1',
    sequence,
    status,
    items: [],
    startedAt: 1,
    updatedAt,
  };
}

function payload(value: AgentTurnSnapshot): AgentTurnEventPayload {
  return {
    contractVersion: 1,
    sessionId: 's1',
    messageId: 'm1',
    turnId: 't1',
    sequence: value.sequence,
    timestamp: value.updatedAt,
    event: 'item_updated',
    snapshot: value,
  };
}

describe('applyAgentTurnEvent', () => {
  it('applies the authoritative snapshot without changing unrelated sessions', () => {
    const other = { ...message(), id: 'm2', sessionId: 's2' };
    const messages = { s1: [message()], s2: [other] };
    const next = applyAgentTurnEvent(
      messages,
      payload(snapshot(2, 'in_progress')),
    );
    expect(next.s1[0]?.turn?.status).toBe('in_progress');
    expect(next.s2).toBe(messages.s2);
  });

  it('ignores an older snapshot delivered after a newer terminal snapshot', () => {
    const terminal = { ...message(), turn: snapshot(4, 'completed', 10) };
    const messages = { s1: [terminal] };
    const next = applyAgentTurnEvent(
      messages,
      payload(snapshot(3, 'in_progress', 20)),
    );
    expect(next).toBe(messages);
    expect(next.s1[0]?.turn?.status).toBe('completed');
  });
});
