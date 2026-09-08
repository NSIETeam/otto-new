/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { TurnDirectiveLedger } from './turnDirectiveLedger.js';

describe('incremental runtime instructions', () => {
  it('sends stable rules once and only changed state thereafter', () => {
    const ledger = new TurnDirectiveLedger();
    const first = ledger.update({
      rules: 'Never infer permission.',
      state: 'revision=0',
    });
    expect(first).toContain('Never infer permission.');
    expect(ledger.update({ state: 'revision=0' })).toBe('');
    expect(ledger.update({ state: 'revision=1' })).toBe('revision=1');
    expect(ledger.update({ state: 'revision=1' })).toBe('');
  });

  it('restores lost rules/state after history compression, but not obsolete state', () => {
    const ledger = new TurnDirectiveLedger();
    const first = ledger.update({ rules: 'Safety rules', state: 'revision=0' });
    const second = ledger.update({ state: 'revision=1' }, [first]);
    expect(ledger.update({}, [first, second])).toBe('');
    expect(ledger.update({}, ['compressed history'])).toBe(
      'Safety rules\nrevision=1',
    );
    expect(ledger.update({}, ['Safety rules'])).toBe('revision=1');
  });

  it('does not mistake a quoted fragment for an intact runtime instruction', () => {
    const ledger = new TurnDirectiveLedger();
    ledger.update({ rules: 'Safety rules' });
    expect(ledger.update({}, ['a source says Safety rules'])).toBe(
      'Safety rules',
    );
  });
});
