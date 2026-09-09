/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { OfficialPolicyDocument } from './contracts.js';
import {
  POLICY_BACKGROUND_RECORD_BYTES,
  type PolicyStore,
} from './policyStore.js';
export interface SourceCollectionStatus {
  checkedAt: string;
  status: 'unverified' | 'available' | 'partial' | 'unavailable';
  documentCount: number;
  failedUrls?: string[];
}
// A bounded reconciliation may take several ticks. Until it reaches a stored
// document, failed/currently-unverified source health must already fail closed.
export async function policyDocumentSourceStatus(
  store: PolicyStore,
  doc: OfficialPolicyDocument,
): Promise<OfficialPolicyDocument> {
  const status = await store.getBounded<SourceCollectionStatus>(
    `source-status:${doc.sourceId}`,
    POLICY_BACKGROUND_RECORD_BYTES,
  );
  return policyDocumentSourceHealth(doc, status);
}
export function policyDocumentSourceHealth(
  doc: OfficialPolicyDocument,
  status: SourceCollectionStatus | null,
): OfficialPolicyDocument {
  return status &&
    (status.status === 'unverified' ||
      status.status === 'unavailable' ||
      status.failedUrls?.includes(doc.url))
    ? { ...doc, sourceStatus: 'unavailable' }
    : doc;
}
