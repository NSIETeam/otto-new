/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type {
  OfficialPolicyDocument,
  PolicyActor,
  PolicyRegion,
} from './contracts.js';
import { sourceMatchesRegion } from './policyDomain.js';
import { policyDocumentSourceStatus } from './policySourceStatus.js';
import {
  advancePolicyMailbox,
  policyMailboxKey,
  type PolicyMailbox,
} from './policyNotifications.js';
import {
  POLICY_BACKGROUND_RECORD_BYTES,
  PolicyRecordTooLargeError,
  type PolicyStore,
} from './policyStore.js';

const PROGRESS_KEY = 'notification:progress';
const MAX_MAILBOXES = 32;
const MAX_DOCUMENTS = 128;
const TICK_MS = 5_000;
const LEASE_MS = 30_000;
const bounded = { maxPayloadBytes: POLICY_BACKGROUND_RECORD_BYTES };
export const POLICY_NOTIFICATION_MAINTENANCE_MESSAGE =
  '政策提醒历史或关联记录超过后台安全上限，历史消息与已读状态已保留；后台提醒待维护，目前不能保证完整提醒。';
export const policyNotificationHealthKey = (mailboxKey: string): string =>
  `notification:health:${mailboxKey}`;
export interface PolicyNotificationHealth {
  status: 'healthy' | 'needs-maintenance';
  checkedAt: string;
}
export interface PolicyNotificationProgress {
  cursor?: string;
  active?: { key: string; after?: string; needsMaintenance?: boolean };
  maintenanceCount: number;
  status: 'pending' | 'idle' | 'needs-maintenance';
  lastCompletedAt?: string;
  lease?: { token: string; until: number };
}
interface Ports {
  store: PolicyStore;
  now(): Date;
  getActor(id: string): Promise<PolicyActor | null>;
  workspace(
    actor: PolicyActor,
  ): Promise<{ enabled: boolean; region: PolicyRegion }>;
  signal?: AbortSignal;
  elapsedNow?: () => number;
}

/** A cursor is an observation checkpoint, not a promise that no later revision
 * exists. Every completed traversal wraps and observes all watches again. The
 * event IDs and readAt live in the original atomic mailbox; cursor replay is
 * therefore safe after a crash between the mailbox write and its checkpoint. */
export async function refreshPolicyNotifications(ports: Ports): Promise<void> {
  const { store } = ports;
  const elapsedNow = ports.elapsedNow ?? (() => performance.now());
  const start = elapsedNow();
  const token = randomUUID();
  let owned = false;
  let progress = await store.update<PolicyNotificationProgress>(
    PROGRESS_KEY,
    (current) => {
      const value = current ?? { status: 'pending', maintenanceCount: 0 };
      if (
        ports.signal?.aborted ||
        (value.lease && value.lease.until > ports.now().getTime())
      )
        return value;
      owned = true;
      return {
        ...value,
        status: 'pending',
        lease: { token, until: ports.now().getTime() + LEASE_MS },
      };
    },
    bounded,
  );
  if (!owned) return;
  const checkpoint = async (): Promise<void> => {
    await store.update<PolicyNotificationProgress>(
      PROGRESS_KEY,
      (current) => {
        if (
          current?.lease?.token !== token ||
          current.lease.until <= ports.now().getTime()
        )
          throw new Error('Policy notification traversal lease expired');
        return {
          ...progress,
          lease: { token, until: ports.now().getTime() + LEASE_MS },
        };
      },
      bounded,
    );
  };
  const mayContinue = (): boolean =>
    !ports.signal?.aborted && elapsedNow() - start < TICK_MS;
  const health = async (
    key: string,
    status: PolicyNotificationHealth['status'],
  ): Promise<void> => {
    await store.update<PolicyNotificationHealth>(
      policyNotificationHealthKey(key),
      () => ({ status, checkedAt: ports.now().toISOString() }),
      bounded,
    );
  };
  const authorized = async (box: PolicyMailbox, key: string) => {
    const actor = await ports.getActor(box.accountId);
    if (
      !actor?.active ||
      actor.id !== box.accountId ||
      actor.organizationId !== box.organizationId ||
      policyMailboxKey(actor) !== key
    )
      return null;
    const workspace = await ports.workspace(actor);
    return workspace.enabled ? workspace : null;
  };
  let mailboxes = 0;
  let documents = 0;
  try {
    while (
      mailboxes < MAX_MAILBOXES &&
      documents < MAX_DOCUMENTS &&
      mayContinue()
    ) {
      if (!progress.active) {
        const page = await store.keysPage('policy-inbox:', {
          after: progress.cursor,
          limit: 1,
        });
        if (!page.rows.length) {
          const maintained = progress.maintenanceCount > 0;
          progress = {
            ...progress,
            cursor: undefined,
            active: undefined,
            maintenanceCount: 0,
            status: maintained ? 'needs-maintenance' : 'idle',
            ...(maintained
              ? {}
              : { lastCompletedAt: ports.now().toISOString() }),
          };
          await checkpoint();
          return;
        }
        progress.active = { key: page.rows[0].key };
        await checkpoint();
      }
      const active = progress.active;
      const key = active.key;
      mailboxes++;
      let complete = false;
      try {
        let mailbox = await store.getBounded<PolicyMailbox>(
          key,
          POLICY_BACKGROUND_RECORD_BYTES,
        );
        if (!mailbox || !Object.keys(mailbox.watches).length) complete = true;
        else {
          const ids = Object.keys(mailbox.watches).sort();
          if (ids.length > 100) {
            active.needsMaintenance = true;
            complete = true;
          } else {
            for (const id of ids) {
              if (active.after !== undefined && id <= active.after) continue;
              if (!mayContinue() || documents >= MAX_DOCUMENTS) break;
              const workspace = await authorized(mailbox, key);
              if (!workspace) {
                complete = true;
                break;
              }
              if (!mayContinue()) break;
              // No public document body is loaded before current tenant and
              // feature authorization, and only the current watched ID is read.
              documents++;
              try {
                const cached = await store.getBounded<OfficialPolicyDocument>(
                  `document:${id}`,
                  POLICY_BACKGROUND_RECORD_BYTES,
                );
                const doc =
                  cached && (await policyDocumentSourceStatus(store, cached));
                if (doc && sourceMatchesRegion(doc, workspace.region)) {
                  const latest = await authorized(mailbox, key);
                  if (!latest || !sourceMatchesRegion(doc, latest.region)) {
                    complete = true;
                    break;
                  }
                  if (!mayContinue()) break;
                  const preview = advancePolicyMailbox(
                    structuredClone(mailbox),
                    [doc],
                    ports.now(),
                  );
                  if (JSON.stringify(preview) !== JSON.stringify(mailbox)) {
                    await checkpoint();
                    ports.signal?.throwIfAborted();
                    mailbox = await store.update<PolicyMailbox>(
                      key,
                      (current) => {
                        if (
                          !current ||
                          current.accountId !== mailbox!.accountId ||
                          current.organizationId !== mailbox!.organizationId
                        )
                          throw new Error('Policy mailbox identity changed');
                        return advancePolicyMailbox(
                          current,
                          [doc],
                          ports.now(),
                        );
                      },
                      bounded,
                    );
                  }
                }
              } catch (error) {
                if (!(error instanceof PolicyRecordTooLargeError)) throw error;
                active.needsMaintenance = true;
              }
              active.after = id;
              await checkpoint();
            }
            complete ||= ids.every(
              (id) => active.after !== undefined && id <= active.after,
            );
          }
        }
      } catch (error) {
        if (!(error instanceof PolicyRecordTooLargeError)) throw error;
        active.needsMaintenance = true;
        complete = true;
      }
      if (active.needsMaintenance) await health(key, 'needs-maintenance');
      if (!complete) return;
      if (!active.needsMaintenance) await health(key, 'healthy');
      progress.cursor = key;
      progress.active = undefined;
      if (active.needsMaintenance) progress.maintenanceCount++;
      await checkpoint();
    }
  } finally {
    await store.update<PolicyNotificationProgress>(
      PROGRESS_KEY,
      (current) => {
        if (!current)
          throw new Error('Policy notification traversal checkpoint missing');
        return current.lease?.token === token
          ? { ...current, lease: undefined }
          : current;
      },
      bounded,
    );
  }
}
