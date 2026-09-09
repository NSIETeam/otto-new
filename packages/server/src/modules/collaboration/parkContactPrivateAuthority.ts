/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { ParkDirectoryReader } from './parkContactDirectory.js';
/** Existing enterprise authority is checked independently; park membership never widens it. */
export async function hasParkContactPrivateAuthority(
  tx: ParkDirectoryReader,
  a: { accountId: string; organizationId: string },
  b: { accountId: string; organizationId: string },
): Promise<boolean> {
  if (a.organizationId !== b.organizationId || a.accountId === b.accountId)
    return false;
  const [features] = await tx.all(
    'SELECT direct_messages FROM organization_features WHERE organization_id=?',
    [a.organizationId],
  );
  if (features?.direct_messages !== true && features?.direct_messages !== 1)
    return false;
  const [direct] = await tx.all(
    'SELECT id FROM direct_messages WHERE organization_id=? AND ((sender_account_id=? AND recipient_account_id=?) OR (sender_account_id=? AND recipient_account_id=?)) LIMIT 1',
    [a.organizationId, a.accountId, b.accountId, b.accountId, a.accountId],
  );
  if (direct) return true;
  const [first, second] = [a.accountId, b.accountId].sort();
  return (
    (
      await tx.all(
        'SELECT conversation_id FROM mls_conversations WHERE organization_id=? AND participant_a_account_id=? AND participant_b_account_id=? LIMIT 1',
        [a.organizationId, first, second],
      )
    ).length > 0
  );
}
