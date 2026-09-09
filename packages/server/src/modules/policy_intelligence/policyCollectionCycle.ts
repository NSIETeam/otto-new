/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import {
  POLICY_BACKGROUND_RECORD_BYTES,
  PolicyRecordTooLargeError,
  type PolicyStore,
} from './policyStore.js';

export const POLICY_COLLECTION_PROGRESS_KEY = 'collection:progress';
const SLOT_MS = 600_000;
const UNIT_MS = { page: 5_000, source: 30_000, model: 90_000 } as const;
const bounded = { maxPayloadBytes: POLICY_BACKGROUND_RECORD_BYTES };
export function policyCollectionSlot(now: Date): string {
  const local = new Date(now.getTime() + 8 * 3600_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (minute < 180) local.setUTCDate(local.getUTCDate() - 1);
  return `${local.toISOString().slice(0, 10)}:${minute >= 180 && minute < 1110 ? '03:00' : '18:30'}`;
}
export interface PolicyCollectionProgress<T> {
  version: 1;
  cycle: string;
  configuration: string;
  slot: string;
  spentMs: number;
  revision: number;
  status: 'pending' | 'awaiting-next-slot' | 'needs-review' | 'complete';
  data: T;
  reviewReason?: string;
  reservation?: {
    kind: keyof typeof UNIT_MS;
    id: string;
    milliseconds: number;
  };
  lease?: { token: string; until: number };
}
export interface PolicyCollectionStep<T> {
  kind: keyof typeof UNIT_MS;
  id: string;
  maxMilliseconds?: number;
  run(data: T, context: { cycle: string; signal: AbortSignal }): Promise<T>;
}
interface Ports<T> {
  store: PolicyStore;
  configuration: string;
  now(): Date;
  elapsedNow?: () => number;
  initial(): T;
  next(data: T): PolicyCollectionStep<T> | null;
  complete(data: T): Promise<void>;
  signal?: AbortSignal;
}

/** This is a checkpoint inside the existing recurring policy task, not a second
 * scheduler. Only successful units advance their cursor. External-call spending
 * is reserved durably before dispatch, so a process loss cannot buy a retry. */
export async function runPolicyCollectionTick<T>(
  ports: Ports<T>,
): Promise<void> {
  if (ports.signal?.aborted) return;
  const { store } = ports;
  const slot = policyCollectionSlot(ports.now());
  const token = randomUUID();
  const elapsedNow = ports.elapsedNow ?? (() => performance.now());
  const tickStarted = elapsedNow();
  let chargedMs = 0;
  let owned = false;
  let progress = await store.update<PolicyCollectionProgress<T>>(
    POLICY_COLLECTION_PROGRESS_KEY,
    (saved) => {
      if (
        ports.signal?.aborted ||
        (saved?.lease && saved.lease.until > ports.now().getTime())
      )
        return saved!;
      if (
        saved?.status === 'needs-review' ||
        (saved?.status === 'complete' && saved.slot === slot)
      )
        return saved;
      let value = saved;
      if (!value || value.status === 'complete')
        value = {
          version: 1,
          cycle: randomUUID(),
          configuration: ports.configuration,
          slot,
          spentMs: 0,
          revision: (saved?.revision ?? 0) + 1,
          status: 'pending',
          data: ports.initial(),
        };
      if (value.configuration !== ports.configuration)
        return {
          ...value,
          status: 'needs-review',
          reviewReason: '来源配置在未完成轮次中变更，需核查后继续。',
        };
      if (value.reservation && value.reservation.kind !== 'page')
        return {
          ...value,
          status: 'needs-review',
          reviewReason:
            '上次来源或模型调用的完成状态未知，已保留预算与进度，禁止自动重试。',
        };
      // Local page updates are idempotent. An unknown reservation remains charged;
      // only its old cursor is replayed. Model/source reservations never take this path.
      value = { ...value, reservation: undefined };
      if (value.slot !== slot)
        value = { ...value, slot, spentMs: 0, status: 'pending' };
      if (value.spentMs >= SLOT_MS)
        return { ...value, status: 'awaiting-next-slot' };
      owned = true;
      return {
        ...value,
        status: 'pending',
        revision: value.revision + 1,
        lease: { token, until: ports.now().getTime() + 120_000 },
      };
    },
    bounded,
  );
  if (!owned) return;
  const checkpoint = async (): Promise<void> => {
    await store.update<PolicyCollectionProgress<T>>(
      POLICY_COLLECTION_PROGRESS_KEY,
      (saved) => {
        if (
          saved?.lease?.token !== token ||
          saved.lease.until <= ports.now().getTime()
        )
          throw new Error('Policy collection lease expired');
        return {
          ...progress,
          revision: saved.revision + 1,
          lease: { token, until: ports.now().getTime() + 120_000 },
        };
      },
      bounded,
    );
  };
  let pages = 0;
  let sources = 0;
  let models = 0;
  try {
    while (!ports.signal?.aborted) {
      const step = ports.next(progress.data);
      if (!step) {
        await ports.complete(progress.data);
        progress = { ...progress, status: 'complete', reservation: undefined };
        await checkpoint();
        return;
      }
      if (pages >= 4 || sources >= 2 || models >= 1) return;
      const reservedMs = step.maxMilliseconds ?? UNIT_MS[step.kind];
      if (
        !Number.isSafeInteger(reservedMs) ||
        reservedMs < 1 ||
        reservedMs > UNIT_MS[step.kind]
      )
        throw new Error('Invalid bounded policy unit duration');
      if (progress.spentMs + reservedMs > SLOT_MS) {
        progress.status = 'awaiting-next-slot';
        await checkpoint();
        return;
      }
      progress.spentMs += reservedMs;
      progress.reservation = {
        kind: step.kind,
        id: step.id,
        milliseconds: reservedMs,
      };
      await checkpoint();
      const reserved = structuredClone(progress);
      const start = elapsedNow();
      const signal = AbortSignal.any([
        ...(ports.signal ? [ports.signal] : []),
        AbortSignal.timeout(reservedMs),
      ]);
      let unitCharged = 0;
      try {
        const data = await step.run(structuredClone(progress.data), {
          cycle: progress.cycle,
          signal,
        });
        signal.throwIfAborted();
        const spent = Math.max(0, elapsedNow() - start);
        unitCharged = spent;
        chargedMs += spent;
        progress.spentMs += spent - reservedMs;
        progress.data = data;
        progress.reservation = undefined;
        if (spent > reservedMs) {
          progress.status = 'needs-review';
          progress.reviewReason =
            '单项后台处理超出协作时间预算，已保存实际耗时，待维护核查。';
        }
        await checkpoint();
        if (progress.status === 'needs-review') return;
      } catch (error) {
        chargedMs -= unitCharged;
        progress = reserved;
        if (step.kind !== 'page') {
          const charge = Math.max(reservedMs, elapsedNow() - start);
          progress.spentMs += charge - reservedMs;
          chargedMs += charge;
          progress.status = 'needs-review';
          progress.reviewReason =
            '来源或模型调用未能确认完成，已保留预算与进度，禁止自动重试。';
          await checkpoint();
          return;
        }
        // No paid/network operation lives in a page. Its durable old cursor is
        // safe to resume even if an intermediate metadata write already landed.
        const spent = Math.max(0, elapsedNow() - start);
        progress.spentMs += spent - reservedMs;
        chargedMs += spent;
        progress.reservation = undefined;
        if (error instanceof PolicyRecordTooLargeError) {
          progress.status = 'needs-review';
          progress.reviewReason =
            '历史政策记录超过后台安全上限，原数据已保留，需维护后继续本轮。';
        }
        await checkpoint();
        if (progress.status === 'needs-review') return;
        if (signal.aborted) return;
        throw error;
      }
      if (step.kind === 'page') pages++;
      else if (step.kind === 'source') sources++;
      else models++;
    }
  } finally {
    await store.update<PolicyCollectionProgress<T>>(
      POLICY_COLLECTION_PROGRESS_KEY,
      (saved) => {
        if (!saved) throw new Error('Policy collection checkpoint missing');
        if (saved.lease?.token !== token) return saved;
        const elapsed = Math.max(0, elapsedNow() - tickStarted);
        const currentSlot = policyCollectionSlot(ports.now());
        // Charge the entire active tick, not the idle minute between ticks. A
        // boundary-spanning tick is conservatively charged in full to its new
        // slot too, so a new slot never erases work already done within it.
        const spentMs =
          currentSlot === saved.slot
            ? saved.spentMs + Math.max(0, elapsed - chargedMs)
            : Math.max(elapsed, saved.reservation?.milliseconds ?? 0);
        return {
          ...saved,
          slot: currentSlot,
          spentMs,
          lease: undefined,
          ...(spentMs > SLOT_MS
            ? {
                status: 'needs-review' as const,
                reviewReason:
                  '后台实际工作超过本时段协作预算，已保留实际耗时，待维护核查。',
              }
            : spentMs >= SLOT_MS && saved.status === 'pending'
              ? { status: 'awaiting-next-slot' as const }
              : {}),
        };
      },
      bounded,
    );
  }
}
