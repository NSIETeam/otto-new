/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
export interface GuardedToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  nativeSafe?: boolean;
}
const guards = new WeakMap<object, (call: GuardedToolCall) => void>();
export function getTurnExecutionGuard(config: object) {
  return guards.get(config);
}
/** Host state separated from native classes so instrumentation can consult the
 * same policy without eagerly loading tools or creating a Config import cycle. */
export function installTurnExecutionGuard(
  config: object,
  guard: (call: GuardedToolCall) => void,
): () => void {
  if (guards.has(config))
    throw new Error('A turn execution guard is already active');
  guards.set(config, guard);
  return () => {
    if (guards.get(config) === guard) guards.delete(config);
  };
}
