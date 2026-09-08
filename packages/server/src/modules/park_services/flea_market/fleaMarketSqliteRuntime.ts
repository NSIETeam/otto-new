/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  Database,
  EncryptedFieldCipher,
  EncryptedObjectStore,
} from '../../data_platform/index.js';
import { createMarketSqliteRepository } from './fleaMarketSqliteRepository.js';
import { createMarketApplication } from './fleaMarketApplication.js';
export function createMarketSqliteRuntime(input: {
  database: Database;
  cipher: EncryptedFieldCipher;
  objects: EncryptedObjectStore;
  enterpriseEnabled(organizationId: string): boolean;
  ready: () => boolean;
  requiresMls?: () => boolean;
}) {
  return createMarketApplication({
    ...input,
    reuseEnterpriseConversations: true,
    repository: createMarketSqliteRepository(input.database),
    async principal(tx, id) {
      const [row] = await tx.all(
        `SELECT a.id,a.name AS nickname,a.organization_id,a.status,o.status AS organization_status,o.park_id,p.status AS park_status
        FROM accounts a JOIN organizations o ON o.id=a.organization_id LEFT JOIN parks p ON p.id=o.park_id WHERE a.id=? AND a.deleted_at IS NULL`,
        [id],
      );
      if (!row) return null;
      const roles = await tx.all(
        'SELECT park_id FROM park_market_admins WHERE account_id=?',
        [id],
      );
      return {
        nickname: String(row.nickname ?? '园区成员'),
        accountId: id,
        organizationId: String(row.organization_id),
        active: row.status === 'active' && row.organization_status === 'active',
        parkId: row.park_id === null ? null : String(row.park_id),
        parkActive: row.park_status === 'active',
        enterpriseEnabled: input.enterpriseEnabled(String(row.organization_id)),
        marketAdminParkIds: roles.map((role) => String(role.park_id)),
      };
    },
    async canAssign(tx, actor, park) {
      const [row] = await tx.all(
        `SELECT a.id FROM accounts a JOIN organizations o ON o.id=a.organization_id JOIN parks p ON p.admin_organization_id=o.id
        WHERE a.id=? AND a.deleted_at IS NULL AND p.id=? AND a.is_admin=1 AND a.status='active' AND o.status='active' AND p.status='active'`,
        [actor, park],
      );
      return !!row;
    },
  });
}
