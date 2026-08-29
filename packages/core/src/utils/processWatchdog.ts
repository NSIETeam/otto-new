/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface ProcessWatchdogDefinitionV1 {
  name: string;
  source: string;
  intervalMs: number;
  cost: 'none';
}

export interface ActiveProcessWatchdogV1 extends ProcessWatchdogDefinitionV1 {
  startedAt: number;
}

const active = new Map<symbol, ActiveProcessWatchdogV1>();

export function listActiveProcessWatchdogs(): ActiveProcessWatchdogV1[] {
  return [...active.values()].map((definition) => ({ ...definition }));
}

export function startProcessWatchdog(
  definition: ProcessWatchdogDefinitionV1,
  task: () => void | Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  if (!definition.name.trim() || !definition.source.trim()) {
    throw new Error('process watchdog name and source are required');
  }
  if (!Number.isFinite(definition.intervalMs) || definition.intervalMs <= 0) {
    throw new Error('process watchdog intervalMs must be positive');
  }
  const id = Symbol(definition.name);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  active.set(id, { ...definition, startedAt: Date.now() });

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      Promise.resolve()
        .then(task)
        .catch(onError)
        .finally(schedule);
    }, definition.intervalMs);
    timer.unref?.();
  };
  schedule();

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    active.delete(id);
  };
}
