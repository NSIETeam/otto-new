/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { TaskContinuityLedger } from './taskContinuity.js';

const request = {
  version: 1 as const,
  text: '生成报告。不要打开 WPS。',
  source: 'local' as const,
  workspacePath: '/repo',
};
it('separates accepted from applied, rejects stale edits and deduplicates exact delivery', () => {
  const ledger = new TaskContinuityLedger('turn', request);
  const edit = {
    version: 1 as const,
    turnId: 'turn',
    expectedRevision: 1,
    mode: 'append' as const,
    clientMessageId: 'user-edit',
    text: '再生成 PDF',
  };
  expect(ledger.accept(edit).revision).toBe(2);
  expect(ledger.pending).toBe(true);
  expect(ledger.request.text).toBe(request.text);
  expect(ledger.accept(edit).revision).toBe(2);
  expect(() => ledger.accept({ ...edit, text: '不同请求' })).toThrow();
  expect(() => ledger.accept({ ...edit, clientMessageId: 'other' })).toThrow();
  ledger.apply();
  expect(ledger.request.text).toContain('再生成 PDF');
  expect(ledger.request.revision).toBe(2);
  expect(ledger.pending).toBe(false);
});
it('replacing goals retains prohibitions unless the caller explicitly releases exact constraint IDs', () => {
  const ledger = new TaskContinuityLedger('turn', request);
  ledger.accept({
    version: 1,
    turnId: 'turn',
    expectedRevision: 1,
    mode: 'replace',
    clientMessageId: 'replace',
    text: '只回答问题',
  });
  ledger.apply();
  expect(ledger.request.text).not.toContain('生成报告');
  expect(ledger.request.text).toContain('不要打开 WPS');
  const restored = TaskContinuityLedger.restore(ledger.snapshot());
  expect(restored.request).toEqual(ledger.request);
  expect(() =>
    TaskContinuityLedger.restore({ ...ledger.snapshot(), appliedRevision: 99 }),
  ).toThrow();
});
it('persists unapplied requests without pretending a restart applied them', () => {
  const ledger = new TaskContinuityLedger('turn', request);
  ledger.accept({
    version: 1,
    turnId: 'turn',
    expectedRevision: 1,
    mode: 'pause',
    clientMessageId: 'pause',
    text: '先停一下',
  });
  const restored = TaskContinuityLedger.restore(ledger.snapshot());
  expect(restored.pending).toBe(true);
  expect(restored.request.text).toBe(request.text);
  restored.apply();
  expect(restored.paused).toBe(true);
});
