/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  E2eeDeviceView,
  E2eeKeyTransparencyView,
} from './e2eeRepository.js';
export interface ParkDirectoryReader {
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<T[]>;
}
/** Caller must establish a specific park listing or participant conversation authority first. */
export async function readParkContactDirectory(
  tx: ParkDirectoryReader,
  accounts: Array<{ accountId: string; organizationId: string }>,
) {
  const result = [];
  for (const account of accounts) {
    const rows = await tx.all(
      'SELECT * FROM e2ee_devices WHERE organization_id=? AND account_id=?',
      [account.organizationId, account.accountId],
    );
    const entries = (
      await tx.all(
        'SELECT * FROM e2ee_key_transparency_log WHERE organization_id=? AND account_id=? ORDER BY sequence',
        [account.organizationId, account.accountId],
      )
    ).map((row) => ({
      sequence: Number(row.sequence),
      accountId: String(row.account_id),
      deviceId: String(row.device_id),
      event: row.event as E2eeKeyTransparencyView['entries'][number]['event'],
      keyFingerprint: String(row.key_fingerprint),
      actorDeviceId:
        row.actor_device_id === null ? null : String(row.actor_device_id),
      previousHash: String(row.previous_hash),
      entryHash: String(row.entry_hash),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    }));
    const devices: E2eeDeviceView[] = rows.map((row) => ({
      accountId: String(row.account_id),
      deviceId: String(row.device_id),
      deviceName: String(row.device_name),
      identitySigningPublicKey: String(row.identity_signing_public_key),
      deviceExchangePublicKey: String(row.device_exchange_public_key),
      keyFingerprint: String(row.key_fingerprint),
      approvalState: row.approval_state as 'pending' | 'approved',
      approvedByDeviceId:
        row.approved_by_device_id === null
          ? null
          : String(row.approved_by_device_id),
      approvedAt:
        row.approved_at === null
          ? null
          : row.approved_at instanceof Date
            ? row.approved_at.toISOString()
            : String(row.approved_at),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      lastSeenAt:
        row.last_seen_at instanceof Date
          ? row.last_seen_at.toISOString()
          : String(row.last_seen_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    }));
    result.push({
      organizationId: account.organizationId,
      devices,
      transparency: {
        accountId: account.accountId,
        headSequence: entries.length,
        headHash: entries.at(-1)?.entryHash ?? '0'.repeat(64),
        entries,
      },
    });
  }
  return result;
}
