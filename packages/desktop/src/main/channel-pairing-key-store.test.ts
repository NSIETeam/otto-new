/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EphemeralChannelPairingKeyStore } from './channel-pairing-key-store.js';

afterEach(() => vi.useRealTimers());

describe('EphemeralChannelPairingKeyStore', () => {
  it('erases device proof keys at the pairing deadline', async () => {
    vi.useFakeTimers();
    const store = new EphemeralChannelPairingKeyStore<{ privateKey: string }>();
    store.set('pair_0123456789abcdef01234567', { privateKey: 'secret' }, Date.now() + 1_000);
    expect(store.get('pair_0123456789abcdef01234567')).toEqual({ privateKey: 'secret' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.get('pair_0123456789abcdef01234567')).toBeUndefined();
  });

  it('replaces and explicitly clears pending keys', () => {
    const store = new EphemeralChannelPairingKeyStore<string>();
    store.set('pair_0123456789abcdef01234567', 'first', Date.now() + 60_000);
    store.set('pair_0123456789abcdef01234567', 'second', Date.now() + 60_000);
    expect(store.get('pair_0123456789abcdef01234567')).toBe('second');
    store.clear();
    expect(store.get('pair_0123456789abcdef01234567')).toBeUndefined();
  });
});
