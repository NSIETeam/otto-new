/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PENDING_STATES = 32;

export interface OneTimeOttoAuthStateStoreOptions {
  ttlMs?: number;
  maxPendingStates?: number;
}

/**
 * Process-local, short-lived OAuth state store.
 *
 * States are cryptographically random, expire quickly and are removed before
 * validation returns so every callback value can succeed at most once.
 */
export class OneTimeOttoAuthStateStore {
  private readonly pending = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxPendingStates: number;

  constructor(options: OneTimeOttoAuthStateStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_STATE_TTL_MS;
    this.maxPendingStates = options.maxPendingStates ?? DEFAULT_MAX_PENDING_STATES;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Otto OAuth state TTL must be a positive number');
    }
    if (!Number.isInteger(this.maxPendingStates) || this.maxPendingStates <= 0) {
      throw new Error('Otto OAuth pending-state limit must be a positive integer');
    }
  }

  issue(): string {
    const now = Date.now();
    this.pruneExpired(now);
    while (this.pending.size >= this.maxPendingStates) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }

    let state: string;
    do {
      state = randomBytes(32).toString('hex');
    } while (this.pending.has(state));
    this.pending.set(state, now + this.ttlMs);
    return state;
  }

  consume(state: string | null | undefined): boolean {
    if (!state) return false;
    const expiresAt = this.pending.get(state);
    if (expiresAt === undefined) return false;

    // Delete before returning so parallel/replayed callbacks fail closed.
    this.pending.delete(state);
    return expiresAt > Date.now();
  }

  clear(): void {
    this.pending.clear();
  }

  private pruneExpired(now: number): void {
    for (const [state, expiresAt] of this.pending) {
      if (expiresAt <= now) this.pending.delete(state);
    }
  }
}
