/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OttoMessage, ServerToClient } from 'otto-server';

export type AgentTurnEventPayload = Extract<
  ServerToClient,
  { type: 'turn_event' }
>['payload'];

/** Apply the authoritative full snapshot carried by every turn event. */
export function applyAgentTurnEvent(
  messages: Record<string, OttoMessage[]>,
  payload: AgentTurnEventPayload,
): Record<string, OttoMessage[]> {
  const list = messages[payload.sessionId];
  if (!list) return messages;
  let changed = false;
  const next = list.map((message) => {
    if (message.id !== payload.messageId) return message;
    const current = message.turn;
    if (
      current?.turnId === payload.turnId &&
      current.sequence >= payload.snapshot.sequence
    ) {
      return message;
    }
    changed = true;
    return { ...message, turn: payload.snapshot };
  });
  return changed ? { ...messages, [payload.sessionId]: next } : messages;
}
