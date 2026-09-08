/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { validateClientPayload } from './protocol.js';
const payload = {
  sessionId: 'session',
  source: 'local',
  clientMessageId: 'edit',
  content: [{ type: 'text', value: '先检查再修改' }],
  steering: { version: 1, turnId: 'turn', expectedRevision: 1, mode: 'append' },
};
it('validates explicit steering and retains compatibility with old queues', () => {
  expect(
    validateClientPayload({ type: 'send_user_message', payload }),
  ).toBeNull();
  expect(
    validateClientPayload({
      type: 'send_user_message',
      payload: { ...payload, steering: undefined, queueAction: 'merge' },
    }),
  ).toBeNull();
});
it.each([
  { source: 'atoa' },
  { clientMessageId: undefined },
  { authorizedContext: 'untrusted' },
  { queueAction: 'next_turn' },
  { steering: { ...payload.steering, expectedRevision: 0 } },
  { steering: { ...payload.steering, mode: 'overwrite' } },
  { content: [{ type: 'text', value: 'x'.repeat(16001) }] },
  { steering: { ...payload.steering, releaseConstraintIds: [42] } },
])('rejects malformed, conflicting or remote steering %#', (changes) => {
  expect(
    validateClientPayload({
      type: 'send_user_message',
      payload: { ...payload, ...changes },
    }),
  ).not.toBeNull();
});
