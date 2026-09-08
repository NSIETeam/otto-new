/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { hasNativeReconciliation } from './restart.js';
import type { ServerToClient } from '../../../server/src/protocol.js';

it('observes the product native awaiting-confirmation notice, not model wording', () => {
  const native = {
    type: 'turn_event',
    payload: {
      snapshot: {
        items: [
          {
            id: 'turn-reconciliation-required',
            type: 'notice',
            status: 'awaiting_confirmation',
            level: 'warning',
          },
        ],
      },
    },
  } as ServerToClient;
  expect(hasNativeReconciliation([native])).toBe(true);
  const modelText = {
    type: 'message_start',
    payload: {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            value: 'recovery_reconciliation_required 请核对上次结果',
          },
        ],
      },
    },
  } as ServerToClient;
  expect(hasNativeReconciliation([modelText])).toBe(false);
  expect(hasNativeReconciliation([])).toBe(false);
  const stale = structuredClone(native);
  if (stale.type === 'turn_event')
    stale.payload.snapshot!.items[0].status = 'completed';
  expect(hasNativeReconciliation([stale])).toBe(false);
});
