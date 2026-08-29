/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface RecurringTaskDefinition {
  name: string;
  source: string;
  definitionVersion?: number;
  intervalMs: number;
  initialDelayMs?: number;
  missedRunPolicy?: 'skip' | 'run-once';
  estimatedCostUsdPerRun: number;
  getInputVersion: () => string | undefined | Promise<string | undefined>;
  run: () => void | Promise<void>;
}

export interface RegisteredRecurringTask {
  name: string;
  source: string;
  definitionVersion: number;
  intervalMs: number;
  estimatedCostUsdPerRun: number;
  paid: boolean;
  inputVersion?: string;
  lastCompletedInputVersion?: string;
  running: boolean;
  nextRunAtMs?: number;
  stop: () => void;
}

export interface RecurringTaskRegistryOptions {
  /** Paid background work is opt-in. Personal/default installations leave this false. */
  allowPaidBackground?: boolean;
  onError?: (taskName: string, error: unknown) => void;
  stateStore?: RecurringTaskStateStore;
  now?: () => number;
}

export interface RecurringTaskState {
  name: string;
  source: string;
  definitionVersion: number;
  lastCompletedInputVersion?: string;
  nextRunAtMs: number;
  updatedAtMs: number;
}

/** Persistence is injected so Core owns the lifecycle contract, not storage. */
export interface RecurringTaskStateStore {
  get(name: string): RecurringTaskState | undefined;
  put(state: RecurringTaskState): void;
}

export class InMemoryRecurringTaskStateStore implements RecurringTaskStateStore {
  private readonly states = new Map<string, RecurringTaskState>();

  get(name: string): RecurringTaskState | undefined {
    const state = this.states.get(name);
    return state ? { ...state } : undefined;
  }

  put(state: RecurringTaskState): void {
    this.states.set(state.name, { ...state });
  }
}

/**
 * The sole scheduler for recurring product work. It uses self-rescheduling
 * timeouts so a slow run cannot overlap with its successor.
 */
export class RecurringTaskRegistry {
  private readonly tasks = new Map<string, RegisteredRecurringTask>();
  private readonly allowPaidBackground: boolean;
  private readonly onError: (taskName: string, error: unknown) => void;
  private readonly stateStore?: RecurringTaskStateStore;
  private readonly now: () => number;

  constructor(options: RecurringTaskRegistryOptions = {}) {
    this.allowPaidBackground = options.allowPaidBackground === true;
    this.onError = options.onError ?? (() => undefined);
    this.stateStore = options.stateStore;
    this.now = options.now ?? Date.now;
  }

  register(definition: RecurringTaskDefinition): (() => void) | undefined {
    if (!definition.name.trim() || !definition.source.trim()) throw new Error('recurring task name and source are required');
    const definitionVersion = definition.definitionVersion ?? 1;
    if (!Number.isSafeInteger(definitionVersion) || definitionVersion <= 0) throw new Error('recurring task definition version must be a positive integer');
    if (!Number.isFinite(definition.intervalMs) || definition.intervalMs <= 0) throw new Error('recurring task interval must be positive');
    if (!Number.isFinite(definition.estimatedCostUsdPerRun) || definition.estimatedCostUsdPerRun < 0) throw new Error('recurring task cost must be non-negative');
    if (this.tasks.has(definition.name)) throw new Error(`recurring task already registered: ${definition.name}`);
    const paid = definition.estimatedCostUsdPerRun > 0;
    if (paid && !this.allowPaidBackground) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const restored = this.stateStore?.get(definition.name);
    const compatibleState = restored?.source === definition.source
      && restored.definitionVersion === definitionVersion
      ? restored
      : undefined;
    const initialVersion = definition.getInputVersion();
    const task: RegisteredRecurringTask = {
      name: definition.name,
      source: definition.source,
      definitionVersion,
      intervalMs: definition.intervalMs,
      estimatedCostUsdPerRun: definition.estimatedCostUsdPerRun,
      paid,
      inputVersion: typeof initialVersion === 'string' ? initialVersion : undefined,
      lastCompletedInputVersion: compatibleState?.lastCompletedInputVersion,
      running: false,
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        this.tasks.delete(definition.name);
      },
    };
    const persist = (nextRunAtMs: number) => {
      task.nextRunAtMs = nextRunAtMs;
      this.stateStore?.put({
        name: task.name,
        source: task.source,
        definitionVersion: task.definitionVersion,
        ...(task.lastCompletedInputVersion === undefined
          ? {}
          : { lastCompletedInputVersion: task.lastCompletedInputVersion }),
        nextRunAtMs,
        updatedAtMs: this.now(),
      });
    };
    const schedule = (delayMs = definition.intervalMs) => {
      const safeDelayMs = Math.max(0, delayMs);
      persist(this.now() + safeDelayMs);
      timer = setTimeout(() => void tick(), safeDelayMs);
      timer.unref?.();
    };
    const tick = async () => {
      if (stopped) return;
      const version = await definition.getInputVersion();
      task.inputVersion = version;
      if (version === undefined || version === task.lastCompletedInputVersion) {
        schedule();
        return;
      }
      task.running = true;
      try {
        await definition.run();
        task.lastCompletedInputVersion = version;
      } catch (error) {
        this.onError(definition.name, error);
      } finally {
        task.running = false;
        if (!stopped) schedule();
      }
    };
    this.tasks.set(definition.name, task);
    if (initialVersion instanceof Promise) {
      void initialVersion.then((version) => {
        if (!stopped) task.inputVersion = version;
      }).catch((error) => this.onError(definition.name, error));
    }
    const configuredInitialDelay = definition.initialDelayMs ?? definition.intervalMs;
    const restoredDelay = compatibleState
      ? compatibleState.nextRunAtMs - this.now()
      : configuredInitialDelay;
    const initialDelay = restoredDelay > 0
      ? restoredDelay
      : definition.missedRunPolicy === 'run-once' ? 0 : definition.intervalMs;
    persist(this.now() + initialDelay);
    timer = setTimeout(() => void tick(), initialDelay);
    timer.unref?.();
    return task.stop;
  }

  list(): RegisteredRecurringTask[] {
    return [...this.tasks.values()];
  }

  stopAll(): void {
    for (const task of [...this.tasks.values()]) task.stop();
  }
}

export const recurringTaskRegistry = new RecurringTaskRegistry();
