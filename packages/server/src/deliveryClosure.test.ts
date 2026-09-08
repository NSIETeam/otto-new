import { describe, expect, it } from 'vitest';
import { DeliveryClosure } from './deliveryClosure.js';

const review = {
  missing: [{ id: 'test', label: '运行登录回归', status: 'not_run' as const }],
  blocked: false,
};
const budget = { remainingRounds: 4, toolFree: false, restricted: false };
describe('bounded pre-delivery closure', () => {
  it('recognizes native coverage progress even when newly planned check IDs differ', () => {
    const closure = new DeliveryClosure();
    expect(closure.next({ ...review, progress: [] }, budget)).toBe(true);
    expect(
      closure.next(
        {
          ...review,
          missing: [{ id: 'new-check', label: 'new', status: 'not_run' }],
          progress: ['coverage:login'],
        },
        budget,
      ),
    ).toBe(true);
    expect(
      closure.next(
        { ...review, progress: ['coverage:login', 'coverage:payment'] },
        budget,
      ),
    ).toBe(false);
  });
  it('continues a missing check once, but stops without verified progress', () => {
    const closure = new DeliveryClosure();
    expect(closure.next(review, budget)).toBe(true);
    expect(closure.next(review, budget)).toBe(false);
  });
  it('allows a second closure only when an outstanding check is satisfied', () => {
    const closure = new DeliveryClosure();
    expect(
      closure.next(
        {
          ...review,
          missing: [
            ...review.missing,
            { id: 'lint', label: 'lint', status: 'failed' },
          ],
        },
        budget,
      ),
    ).toBe(true);
    expect(closure.next(review, budget)).toBe(true);
    expect(
      closure.next(
        {
          ...review,
          missing: [{ id: 'other', label: 'other', status: 'not_run' }],
        },
        budget,
      ),
    ).toBe(false);
  });
  it.each([
    { ...budget, remainingRounds: 1 },
    { ...budget, restricted: true },
    { ...budget, toolFree: true },
  ])(
    'does not expand execution authority or consume the final round: %j',
    (limits) => {
      expect(new DeliveryClosure().next(review, limits)).toBe(false);
    },
  );
  it('never retries a human/permission/reconciliation blocker or a finished turn', () => {
    expect(
      new DeliveryClosure().next({ ...review, blocked: true }, budget),
    ).toBe(false);
    expect(new DeliveryClosure().next({ ...review, missing: [] }, budget)).toBe(
      false,
    );
  });
});
