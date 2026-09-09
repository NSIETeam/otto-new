/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { marketRequest } from './parkMarketApi.js';
/** Owned by one mounted account view; never shared across account boundaries. */
export class MarketMutation {
  private readonly receipts = new Map<string, string>();
  private readonly active = new Map<string, Promise<unknown>>();
  run<T>(
    path: string,
    method: 'POST' | 'PUT',
    body: Record<string, unknown>,
  ): Promise<T> {
    const key = JSON.stringify([path, method, body]);
    const running = this.active.get(key);
    if (running) return running as Promise<T>;
    const requestId = this.receipts.get(key) ?? crypto.randomUUID();
    this.receipts.set(key, requestId);
    const promise = marketRequest<T>(path, method, { ...body, requestId })
      .then((value) => {
        this.receipts.delete(key);
        return value;
      })
      .finally(() => this.active.delete(key));
    this.active.set(key, promise);
    return promise;
  }
}
