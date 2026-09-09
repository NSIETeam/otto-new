/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import { MarketMutation } from './parkMarketMutation.js';
it('retries an unknown mutation using the exact original receipt and retires it after success', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('network timeout'))
    .mockResolvedValue({ version: 2 });
  Object.assign(window.otto, { enterpriseParkMarket: request });
  const mutation = new MarketMutation();
  const body = { expectedVersion: 1, reason: '核实违规' };
  await expect(mutation.run('/reports/r/decide', 'POST', body)).rejects.toThrow(
    'timeout',
  );
  await mutation.run('/reports/r/decide', 'POST', body);
  expect(request.mock.calls[0][0].body.requestId).toBe(
    request.mock.calls[1][0].body.requestId,
  );
  await mutation.run('/reports/r/decide', 'POST', body);
  expect(request.mock.calls[2][0].body.requestId).not.toBe(
    request.mock.calls[1][0].body.requestId,
  );
});
it('coalesces double clicks instead of sending concurrent copies', async () => {
  let finish!: (value: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  Object.assign(window.otto, { enterpriseParkMarket: request });
  const mutation = new MarketMutation();
  const one = mutation.run('/listings/a/sold', 'POST', { expectedVersion: 1 });
  const two = mutation.run('/listings/a/sold', 'POST', { expectedVersion: 1 });
  expect(request).toHaveBeenCalledOnce();
  finish({ version: 2 });
  expect(await one).toEqual(await two);
});
