/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

const PAIRING_ID_PATTERN = /^pair_[a-f0-9]{24}$/;

export class EphemeralChannelPairingKeyStore<T> {
  private readonly entries = new Map<string, {
    value: T;
    timer: ReturnType<typeof setTimeout>;
  }>();

  set(pairingId: string, value: T, expiresAtMs: number): void {
    if (!PAIRING_ID_PATTERN.test(pairingId)) throw new Error('invalid channel pairing id');
    if (!Number.isFinite(expiresAtMs)) throw new Error('invalid channel pairing expiry');
    this.delete(pairingId);
    const timer = setTimeout(() => this.entries.delete(pairingId), Math.max(0, expiresAtMs - Date.now()));
    timer.unref?.();
    this.entries.set(pairingId, { value, timer });
  }

  get(pairingId: string): T | undefined {
    return this.entries.get(pairingId)?.value;
  }

  delete(pairingId: string): boolean {
    const entry = this.entries.get(pairingId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    return this.entries.delete(pairingId);
  }

  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
}
