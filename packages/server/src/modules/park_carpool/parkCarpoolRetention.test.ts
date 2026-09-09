/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { emptyCarpoolWorkflow } from './parkCarpoolWorkflow.js';
import { pruneCarpoolWorkflow } from './parkCarpoolRetention.js';
it('deletion keeps archived conversations terminal and other users blocks effective', () => {
  const state = emptyCarpoolWorkflow();
  state.blocks.push({ from: 'b', to: 'a' });
  state.conversations.push({
    id: 'closed',
    kind: 'group',
    status: 'archived',
    generation: 2,
    generations: [
      {
        generation: 1,
        createdAt: '2026-09-08T00:00:00Z',
        retiredAt: '2026-09-08T01:00:00Z',
        members: ['a', 'b', 'c'].map((accountId) => ({
          accountId,
          organizationId: 'org',
        })),
      },
    ],
  } as (typeof state.conversations)[number]);
  pruneCarpoolWorkflow(state, '2026-09-08T02:00:00Z', ['a']);
  expect(state.blocks).toEqual([{ from: 'b', to: 'a' }]);
  expect(state.conversations[0]?.status).toBe('archived');
  expect(state.conversations[0]?.generation).toBe(2);
});
