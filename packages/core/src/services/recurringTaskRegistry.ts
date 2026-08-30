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
  phase: 'scheduled' | 'evaluating' | 'running' | 'stopping' | 'stopped';
  nextRunAtMs?: number;
  stop: () => void;
}

export interface RecurringTaskShutdownOptions {
  /** Maximum time to wait for already-started work. No task is blindly aborted. */
  timeoutMs?: number;
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
  private readonly runtimes = new Map<
    string,
    {
      task: RegisteredRecurringTask;
      stopped: boolean;
      generation: number;
      timer?: ReturnType<typeof setTimeout>;
      inFlight?: Promise<void>;
      /** Retries only the durable checkpoint after an accepted external effect. */
      retryCheckpoint?: () => void;
    }
  >();
  private readonly allowPaidBackground: boolean;
  private readonly onError: (taskName: string, error: unknown) => void;
  private readonly stateStore?: RecurringTaskStateStore;
  private readonly now: () => number;
  private readonly checkpointErrors = new Map<string, unknown>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: RecurringTaskRegistryOptions = {}) {
    this.allowPaidBackground = options.allowPaidBackground === true;
    this.onError = options.onError ?? (() => undefined);
    this.stateStore = options.stateStore;
    this.now = options.now ?? Date.now;
  }

  register(definition: RecurringTaskDefinition): (() => void) | undefined {
    if (this.shuttingDown)
      throw new Error('recurring task registry is shutting down');
    if (!definition.name.trim() || !definition.source.trim())
      throw new Error('recurring task name and source are required');
    const definitionVersion = definition.definitionVersion ?? 1;
    if (!Number.isSafeInteger(definitionVersion) || definitionVersion <= 0)
      throw new Error(
        'recurring task definition version must be a positive integer',
      );
    if (!Number.isFinite(definition.intervalMs) || definition.intervalMs <= 0)
      throw new Error('recurring task interval must be positive');
    if (
      !Number.isFinite(definition.estimatedCostUsdPerRun) ||
      definition.estimatedCostUsdPerRun < 0
    )
      throw new Error('recurring task cost must be non-negative');
    // A stopped task may still be draining an external write. Its name remains
    // reserved until that in-flight promise settles, otherwise the old cleanup
    // could delete or be confused with a newly registered task of the same name.
    if (
      this.runtimes.has(definition.name) ||
      this.checkpointErrors.has(definition.name)
    ) {
      throw new Error(`recurring task already registered: ${definition.name}`);
    }
    const paid = definition.estimatedCostUsdPerRun > 0;
    if (paid && !this.allowPaidBackground) return undefined;

    const reportError = (error: unknown) => {
      try {
        this.onError(definition.name, error);
      } catch {
        // Error reporting must never become a second scheduler failure.
      }
    };
    let restored: RecurringTaskState | undefined;
    try {
      restored = this.stateStore?.get(definition.name);
    } catch (error) {
      reportError(error);
    }
    const compatibleState =
      restored?.source === definition.source &&
      restored.definitionVersion === definitionVersion
        ? restored
        : undefined;
    const task: RegisteredRecurringTask = {
      name: definition.name,
      source: definition.source,
      definitionVersion,
      intervalMs: definition.intervalMs,
      estimatedCostUsdPerRun: definition.estimatedCostUsdPerRun,
      paid,
      inputVersion: undefined,
      lastCompletedInputVersion: compatibleState?.lastCompletedInputVersion,
      running: false,
      phase: 'scheduled',
      stop: () => undefined,
    };
    const runtime = {
      task,
      stopped: false,
      generation: 0,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      inFlight: undefined as Promise<void> | undefined,
      retryCheckpoint: undefined as (() => void) | undefined,
    };
    const stop = () => {
      if (runtime.stopped) return;
      runtime.stopped = true;
      runtime.generation += 1;
      task.phase =
        runtime.inFlight || runtime.retryCheckpoint ? 'stopping' : 'stopped';
      if (runtime.timer) {
        clearTimeout(runtime.timer);
        runtime.timer = undefined;
      }
      this.tasks.delete(definition.name);
      if (
        !runtime.inFlight &&
        !runtime.retryCheckpoint &&
        this.runtimes.get(definition.name) === runtime
      ) {
        this.runtimes.delete(definition.name);
      }
    };
    task.stop = stop;
    const persist = (nextRunAtMs: number, required = false) => {
      task.nextRunAtMs = nextRunAtMs;
      try {
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
      } catch (error) {
        reportError(error);
        if (required) {
          const failure = new Error(
            `recurring task completion checkpoint failed: ${definition.name}`,
            { cause: error },
          );
          this.checkpointErrors.set(definition.name, failure);
          throw failure;
        }
      }
      if (required) this.checkpointErrors.delete(definition.name);
    };
    const checkpointCompletion = () => {
      persist(this.now() + definition.intervalMs, true);
      runtime.retryCheckpoint = undefined;
      if (runtime.stopped) {
        task.phase = 'stopped';
        if (this.runtimes.get(definition.name) === runtime) {
          this.runtimes.delete(definition.name);
        }
      }
    };
    const schedule = (delayMs = definition.intervalMs) => {
      if (runtime.stopped) return;
      const safeDelayMs = Math.max(0, delayMs);
      persist(this.now() + safeDelayMs);
      const generation = runtime.generation;
      task.phase = 'scheduled';
      runtime.timer = setTimeout(() => {
        runtime.timer = undefined;
        const inFlight = tick(generation);
        runtime.inFlight = inFlight;
        const settle = () => {
          if (runtime.inFlight === inFlight) runtime.inFlight = undefined;
          if (runtime.stopped) {
            task.phase = runtime.retryCheckpoint ? 'stopping' : 'stopped';
            if (
              !runtime.retryCheckpoint &&
              this.runtimes.get(definition.name) === runtime
            ) {
              this.runtimes.delete(definition.name);
            }
          }
        };
        // A mandatory checkpoint failure remains observable to shutdown, but
        // every timer promise also has a rejection handler so it cannot become
        // an unhandled process-level rejection.
        void inFlight.then(settle, settle);
      }, safeDelayMs);
      runtime.timer.unref?.();
    };
    const tick = async (generation: number) => {
      if (runtime.stopped || generation !== runtime.generation) return;
      try {
        // A remote effect may already have succeeded while its durable
        // checkpoint failed. Retry only the checkpoint before reading new
        // input; never replay that effect in the current process.
        runtime.retryCheckpoint?.();
        task.phase = 'evaluating';
        let version: string | undefined;
        try {
          version = await definition.getInputVersion();
        } catch (error) {
          reportError(error);
          return;
        }
        if (runtime.stopped || generation !== runtime.generation) return;
        task.inputVersion = version;
        if (version === undefined || version === task.lastCompletedInputVersion)
          return;
        task.running = true;
        task.phase = 'running';
        try {
          await definition.run();
        } catch (error) {
          reportError(error);
          return;
        }
        task.lastCompletedInputVersion = version;
        // A completed external effect must be checkpointed before shutdown is
        // allowed to finish, otherwise the next process may replay it.
        runtime.retryCheckpoint = checkpointCompletion;
        runtime.retryCheckpoint();
      } finally {
        task.running = false;
        if (!runtime.stopped && generation === runtime.generation) schedule();
        else task.phase = runtime.inFlight ? 'stopping' : 'stopped';
      }
    };
    this.tasks.set(definition.name, task);
    this.runtimes.set(definition.name, runtime);
    const configuredInitialDelay =
      definition.initialDelayMs ?? definition.intervalMs;
    const restoredDelay = compatibleState
      ? compatibleState.nextRunAtMs - this.now()
      : configuredInitialDelay;
    const initialDelay =
      restoredDelay > 0
        ? restoredDelay
        : definition.missedRunPolicy === 'run-once'
          ? 0
          : definition.intervalMs;
    // Preserve the useful immediate snapshot for synchronous getters. Async
    // initial evaluation is tracked as in-flight and must settle before the
    // first timer is armed, so shutdown can drain it and no second getter can
    // overlap it.
    let initialVersion: ReturnType<RecurringTaskDefinition['getInputVersion']>;
    try {
      initialVersion = definition.getInputVersion();
    } catch (error) {
      reportError(error);
      initialVersion = undefined;
    }
    if (initialVersion instanceof Promise) {
      const generation = runtime.generation;
      task.phase = 'evaluating';
      const inFlight = initialVersion
        .then((version) => {
          if (!runtime.stopped && generation === runtime.generation) {
            task.inputVersion = version;
          }
        })
        .catch(reportError)
        .finally(() => {
          if (runtime.inFlight === inFlight) runtime.inFlight = undefined;
          if (runtime.stopped) {
            task.phase = runtime.retryCheckpoint ? 'stopping' : 'stopped';
            if (
              !runtime.retryCheckpoint &&
              this.runtimes.get(definition.name) === runtime
            ) {
              this.runtimes.delete(definition.name);
            }
          } else if (generation === runtime.generation) {
            schedule(initialDelay);
          }
        });
      runtime.inFlight = inFlight;
    } else {
      task.inputVersion = initialVersion;
      schedule(initialDelay);
    }
    return stop;
  }

  list(): RegisteredRecurringTask[] {
    return [...this.tasks.values()];
  }

  stopAll(): void {
    for (const task of [...this.tasks.values()]) task.stop();
  }

  /**
   * Stops future scheduling and drains work that had already started. External
   * writes are deliberately not aborted because their outcome may already be
   * accepted by a remote system and must be checkpointed before teardown.
   */
  shutdown(options: RecurringTaskShutdownOptions = {}): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new Error('recurring task shutdown timeout must be positive'),
      );
    }
    this.shuttingDown = true;
    const deadlineAtMs = Date.now() + timeoutMs;
    this.stopAll();
    const drain = async () => {
      const pending = [...this.runtimes.values()]
        .map((runtime) => runtime.inFlight)
        .filter((value): value is Promise<void> => value !== undefined);
      if (pending.length > 0) {
        const remainingMs = Math.max(0, deadlineAtMs - Date.now());
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const active = [...this.runtimes.values()]
              .filter((runtime) => runtime.inFlight)
              .map((runtime) => `${runtime.task.name} (${runtime.task.phase})`);
            reject(
              new Error(
                `recurring task shutdown timed out after ${timeoutMs}ms: ${active.join(', ') || 'unknown task'}`,
              ),
            );
          }, remainingMs);
        });
        try {
          // Completion-checkpoint rejection is handled by the bounded retry
          // loop below. Waiting for all settlements still guarantees every
          // already-started effect has either failed or reached checkpointing.
          await Promise.race([Promise.allSettled(pending), timedOut]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      let retryDelayMs = 50;
      while (this.checkpointErrors.size > 0) {
        for (const runtime of [...this.runtimes.values()]) {
          if (!runtime.retryCheckpoint) continue;
          try {
            runtime.retryCheckpoint();
          } catch {
            // persist() recorded and reported the latest failure. Retry only
            // that checkpoint until the shared shutdown deadline expires.
          }
        }
        if (this.checkpointErrors.size === 0) break;
        const remainingMs = deadlineAtMs - Date.now();
        if (remainingMs <= 0) {
          throw new AggregateError(
            [...this.checkpointErrors.values()],
            `recurring task shutdown blocked by ${this.checkpointErrors.size} failed completion checkpoint(s) after ${timeoutMs}ms`,
          );
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(retryDelayMs, remainingMs));
        });
        retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
      }
    };
    this.shutdownPromise = drain();
    return this.shutdownPromise;
  }
}

export const recurringTaskRegistry = new RecurringTaskRegistry();
