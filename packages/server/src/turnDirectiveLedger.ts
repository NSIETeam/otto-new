/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

/** Per-turn prompt transport cache, not an authorization or verification gate.
 * Native policy remains authoritative even when no instructions are emitted.
 */
export class TurnDirectiveLedger {
  private readonly current = new Map<string, string>();
  private readonly sent = new Map<string, string>();

  update(
    changes: Record<string, string>,
    retainedUserText?: readonly string[],
  ): string {
    for (const [key, text] of Object.entries(changes)) {
      if (text) this.current.set(key, text);
      else this.current.delete(key);
    }
    const delta: string[] = [];
    for (const [key, text] of this.current) {
      // If history was compressed/replaced, restore the current rules/state.
      // Without a history API (test adapters), use the per-turn send ledger.
      const retained =
        retainedUserText === undefined ||
        retainedUserText.some((entry) =>
          `\n${entry}\n`.includes(`\n${text}\n`),
        );
      if (this.sent.get(key) === text && retained) continue;
      delta.push(text);
      this.sent.set(key, text);
    }
    return delta.join('\n');
  }
}
