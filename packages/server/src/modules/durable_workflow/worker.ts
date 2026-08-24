/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import {
  DurableWorkflowExecutionError,
  type DurableWorkflowClaim,
  type DurableWorkflowFailureCertainty,
  type DurableWorkflowQueueStore,
} from './contracts.js';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;

export interface DurableWorkflowExecutor {
  execute(input: {
    claim: DurableWorkflowClaim;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export interface DurableWorkflowWorkerStatus {
  workerId: string;
  running: boolean;
  activeClaims: number;
  recoveredAtStartup: number;
  lastClaimedAt: string | null;
  lastRecoveryAt: string | null;
  lastError: string | null;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Durable workflow setting must be from ${min} to ${max}`);
  }
  return value;
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1_000,
  );
}

function failureCertainty(error: unknown): DurableWorkflowFailureCertainty {
  return error instanceof DurableWorkflowExecutionError
    ? error.certainty
    : 'unknown_outcome';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Multi-instance durable queue worker. PostgreSQL lease tokens fence stale
 * workers; an aborted executor is never allowed to publish a late result.
 */
export class DurableWorkflowWorker {
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly concurrency: number;
  private readonly shutdownGraceMs: number;
  private readonly recoverySweepMs: number;
  private readonly lifecycle = new AbortController();
  private readonly claimControllers = new Set<AbortController>();
  private readonly active = new Set<Promise<void>>();
  private loopPromise: Promise<void> | null = null;
  private recoveredAtStartup = 0;
  private lastClaimedAt: string | null = null;
  private lastRecoveryAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: DurableWorkflowQueueStore,
    private readonly executor: DurableWorkflowExecutor,
    private readonly workerId: string,
    options: {
      leaseMs?: number;
      pollMs?: number;
      concurrency?: number;
      shutdownGraceMs?: number;
      recoverySweepMs?: number;
    } = {},
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(workerId)) {
      throw new Error('Durable workflow worker id is invalid');
    }
    this.leaseMs = boundedInteger(
      options.leaseMs,
      DEFAULT_LEASE_MS,
      1_000,
      10 * 60_000,
    );
    this.pollMs = boundedInteger(options.pollMs, DEFAULT_POLL_MS, 25, 60_000);
    this.concurrency = boundedInteger(options.concurrency, 2, 1, 32);
    this.shutdownGraceMs = boundedInteger(
      options.shutdownGraceMs,
      10_000,
      100,
      600_000,
    );
    this.recoverySweepMs = boundedInteger(
      options.recoverySweepMs,
      5_000,
      100,
      60_000,
    );
  }

  async start(): Promise<void> {
    if (this.loopPromise) return;
    if (this.lifecycle.signal.aborted) {
      throw new Error(
        'Durable workflow worker cannot be restarted after close',
      );
    }
    this.recoveredAtStartup = await this.store.recoverExpiredWork({
      limit: 500,
    });
    this.lastRecoveryAt = new Date().toISOString();
    this.loopPromise = this.loop();
  }

  async runOnce(): Promise<boolean> {
    if (this.lifecycle.signal.aborted) return false;
    const claim = await this.store.claimNext({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
    if (!claim) return false;
    this.lastClaimedAt = new Date().toISOString();
    await this.executeClaim(claim);
    return true;
  }

  status(): DurableWorkflowWorkerStatus {
    return {
      workerId: this.workerId,
      running: Boolean(this.loopPromise) && !this.lifecycle.signal.aborted,
      activeClaims: this.active.size,
      recoveredAtStartup: this.recoveredAtStartup,
      lastClaimedAt: this.lastClaimedAt,
      lastRecoveryAt: this.lastRecoveryAt,
      lastError: this.lastError,
    };
  }

  async close(): Promise<void> {
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort();
    for (const controller of this.claimControllers) controller.abort();
    await this.loopPromise;
    await Promise.race([
      Promise.allSettled([...this.active]),
      delay(this.shutdownGraceMs, new AbortController().signal),
    ]);
  }

  private async loop(): Promise<void> {
    while (!this.lifecycle.signal.aborted) {
      if (
        !this.lastRecoveryAt ||
        Date.now() - Date.parse(this.lastRecoveryAt) >= this.recoverySweepMs
      ) {
        try {
          await this.store.recoverExpiredWork({ limit: 100 });
          this.lastRecoveryAt = new Date().toISOString();
        } catch (error) {
          this.lastError = errorSummary(error);
        }
      }
      let claimed = false;
      while (
        !this.lifecycle.signal.aborted &&
        this.active.size < this.concurrency
      ) {
        let claim: DurableWorkflowClaim | null = null;
        try {
          claim = await this.store.claimNext({
            workerId: this.workerId,
            leaseMs: this.leaseMs,
          });
        } catch (error) {
          this.lastError = errorSummary(error);
          break;
        }
        if (!claim) break;
        claimed = true;
        this.lastClaimedAt = new Date().toISOString();
        const execution = this.executeClaim(claim).finally(() => {
          this.active.delete(execution);
        });
        this.active.add(execution);
      }

      if (this.active.size > 0) {
        await Promise.race([
          ...this.active,
          delay(this.pollMs, this.lifecycle.signal),
        ]);
      } else if (!claimed) {
        await delay(this.pollMs, this.lifecycle.signal);
      }
    }
  }

  private async executeClaim(claim: DurableWorkflowClaim): Promise<void> {
    const execution = new AbortController();
    const heartbeatStop = new AbortController();
    this.claimControllers.add(execution);
    let leaseLost = false;
    const heartbeat = (async () => {
      while (!heartbeatStop.signal.aborted && !execution.signal.aborted) {
        await delay(
          Math.max(250, Math.floor(this.leaseMs / 3)),
          heartbeatStop.signal,
        );
        if (heartbeatStop.signal.aborted || execution.signal.aborted) return;
        try {
          const renewed = await this.store.renewLease({
            claim,
            leaseMs: this.leaseMs,
          });
          if (!renewed) {
            leaseLost = true;
            execution.abort();
            return;
          }
        } catch (error) {
          this.lastError = errorSummary(error);
          leaseLost = true;
          execution.abort();
          return;
        }
      }
    })();

    const closeListener = (): void => execution.abort();
    this.lifecycle.signal.addEventListener('abort', closeListener, {
      once: true,
    });
    try {
      const output = await this.executor.execute({
        claim,
        signal: execution.signal,
      });
      if (!leaseLost && !execution.signal.aborted) {
        await this.store.succeedClaim({ claim, output });
      }
    } catch (error) {
      if (!leaseLost && !this.lifecycle.signal.aborted) {
        try {
          await this.store.failClaim({
            claim,
            error: errorSummary(error),
            certainty: failureCertainty(error),
          });
        } catch (storeError) {
          this.lastError = errorSummary(storeError);
        }
      }
    } finally {
      heartbeatStop.abort();
      await heartbeat;
      this.lifecycle.signal.removeEventListener('abort', closeListener);
      this.claimControllers.delete(execution);
    }
  }
}
