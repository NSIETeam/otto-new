/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { ParkCarpoolIntent } from './parkCarpoolDomain.js';

export interface PublicationRecord {
  version: number;
  hash: string;
  leaseId: string;
  leaseUntil: number;
  receipt?: ParkCarpoolIntent;
}
export interface PublicationStore {
  readPublication(
    accountId: string,
    requestKey: string,
  ): Promise<PublicationRecord | null>;
  writePublication(
    accountId: string,
    requestKey: string,
    record: PublicationRecord,
    expectedVersion: number | null,
  ): Promise<boolean>;
}

/** Database-backed request identity. The lease prevents simultaneous provider work
 * across server processes. A completed receipt survives subsequent intent edits.
 */
export async function withPublication(
  store: PublicationStore,
  accountId: string,
  requestKey: string,
  hash: string,
  execute: (publication: {
    key: string;
    record: PublicationRecord;
  }) => Promise<ParkCarpoolIntent>,
): Promise<ParkCarpoolIntent> {
  const previous = await store.readPublication(accountId, requestKey);
  if (previous && previous.hash !== hash)
    throw new Error('同一发布请求标识不能用于不同内容');
  if (previous?.receipt) return previous.receipt;
  if (previous && previous.leaseUntil > Date.now())
    throw new Error('发布请求正在处理，请稍后使用同一请求重试');
  const record: PublicationRecord = {
    version: (previous?.version ?? 0) + 1,
    hash,
    leaseId: randomUUID(),
    leaseUntil: Date.now() + 30_000,
  };
  if (
    !(await store.writePublication(
      accountId,
      requestKey,
      record,
      previous?.version ?? null,
    ))
  ) {
    throw new Error('发布请求正在处理，请稍后使用同一请求重试');
  }
  try {
    const receipt = await execute({ key: requestKey, record });
    return receipt;
  } catch (error) {
    await store
      .writePublication(
        accountId,
        requestKey,
        { ...record, version: record.version + 1, leaseUntil: 0 },
        record.version,
      )
      .catch(() => false);
    throw error;
  }
}
