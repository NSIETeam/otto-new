/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface TrayMenuInput {
  status: string;
  restarting: boolean;
  contacts: ReadonlyArray<{ count: number }>;
}

/** Fingerprints only values rendered by the tray menu, so unchanged idle state is skipped. */
export function trayMenuInputVersion(input: TrayMenuInput): string {
  const unreadTotal = input.contacts.reduce(
    (total, contact) => total + contact.count,
    0,
  );
  return JSON.stringify([
    input.status,
    input.restarting,
    input.contacts.length,
    unreadTotal,
  ]);
}
