import { createMarketPostgresImageQuota } from './fleaMarketStorageQuota.js';
import { assertLocalMarketPostgres } from './fleaMarketReadiness.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { PostgresPoolLike } from '../../data_platform/postgresDatabaseLifecycle.js';
import type { EncryptedFieldCipher } from '../../data_platform/encryptedFieldCipher.js';
import type { MarketObjectStore } from './fleaMarketObjectStore.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
import { createMarketApplication } from './fleaMarketApplication.js';
import { createMarketPostgresRepository } from './fleaMarketPostgresRepository.js';
async function identity(tx: MarketTransaction, id: string) {
  const [row] = await tx.all(
    `SELECT a.id,a.name AS nickname,a.organization_id,a.is_admin,a.status,a.deleted_at,o.status AS organization_status,f.park_services
    FROM accounts a JOIN organizations o ON o.id=a.organization_id LEFT JOIN organization_features f ON f.organization_id=o.id WHERE a.id=?`,
    [id],
  );
  if (!row || row.deleted_at) return null;
  const org = String(row.organization_id);
  const [own] = await tx.all(
    "SELECT resource_id,status,payload FROM enterprise_business_records WHERE organization_id=? AND domain='park' AND resource_type='park' AND resource_id=?",
    [org, `park_${org}`],
  );
  let park = own;
  if (!park) {
    const [membership] = await tx.all(
      "SELECT payload FROM enterprise_business_records WHERE organization_id=? AND domain='park' AND resource_type='membership' AND resource_id=? AND status='active'",
      [org, `membership_${org}`],
    );
    if (membership) {
      const binding = membership.payload as {
        parkId: string;
        adminOrganizationId: string;
      };
      [park] = await tx.all(
        "SELECT resource_id,status,payload FROM enterprise_business_records WHERE organization_id=? AND domain='park' AND resource_type='park' AND resource_id=?",
        [binding.adminOrganizationId, binding.parkId],
      );
    }
  }
  return { row, park };
}
export function createMarketPostgresRuntime(input: {
  pool: PostgresPoolLike;
  cipher: EncryptedFieldCipher;
  objects: MarketObjectStore;
  ready?: () => boolean;
  localAcceptance?: boolean;
  requiresMls?: () => boolean;
  defaultQuotaBytes: number;
}) {
  return createMarketApplication({
    ...input,
    async localDatabaseProbe() {
      const result = await input.pool.query(
        "SELECT inet_server_addr() IS NULL AS local_socket,current_setting('data_directory') AS data_directory",
      );
      await assertLocalMarketPostgres(result.rows[0] ?? {});
    },
    reuseEnterpriseConversations: true,
    imageQuota: createMarketPostgresImageQuota(input.defaultQuotaBytes),
    repository: createMarketPostgresRepository(input.pool),
    async principal(tx, id) {
      const value = await identity(tx, id);
      if (!value) return null;
      const { row, park } = value;
      const roles = await tx.all(
        'SELECT park_id FROM park_market_admins WHERE account_id=?',
        [id],
      );
      return {
        nickname: String(row.nickname ?? '园区成员'),
        accountId: id,
        organizationId: String(row.organization_id),
        active: row.status === 'active' && row.organization_status === 'active',
        parkId: park ? String(park.resource_id) : null,
        parkActive: park?.status === 'active',
        enterpriseEnabled: row.park_services === true,
        marketAdminParkIds: roles.map((role) => String(role.park_id)),
      };
    },
    async canAssign(tx, id, parkId) {
      const value = await identity(tx, id);
      return (
        !!value &&
        value.row.status === 'active' &&
        value.row.organization_status === 'active' &&
        value.row.is_admin === true &&
        value.park?.status === 'active' &&
        value.park.resource_id === parkId &&
        (value.park.payload as { adminOrganizationId?: string })
          .adminOrganizationId === value.row.organization_id
      );
    },
  });
}
