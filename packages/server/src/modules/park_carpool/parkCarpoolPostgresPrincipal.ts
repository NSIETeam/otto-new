/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { PostgresClientLike } from '../data_platform/postgresDatabaseLifecycle.js';
import type { ParkCarpoolPrincipal } from './parkCarpoolService.js';
/** All reads use the caller's connection, including inside workflow transactions. */
export async function readCarpoolPostgresPrincipal(
  connection: Pick<PostgresClientLike, 'query'>,
  accountId: string,
): Promise<ParkCarpoolPrincipal | null> {
  const accounts = await connection.query<Record<string, unknown>>(
    `SELECT a.id,a.organization_id,a.name,a.is_admin,a.status,a.deleted_at,
    o.name AS organization_name,o.status AS organization_status,f.park_services
    FROM accounts a JOIN organizations o ON o.id=a.organization_id
    LEFT JOIN organization_features f ON f.organization_id=o.id WHERE a.id=$1`,
    [accountId],
  );
  const row = accounts.rows[0];
  if (!row || row.deleted_at) return null;
  const organizationId = String(row.organization_id);
  const own = await connection.query<Record<string, unknown>>(
    "SELECT resource_id,status,payload FROM enterprise_business_records WHERE organization_id=$1 AND domain='park' AND resource_type='park' AND resource_id=$2",
    [organizationId, `park_${organizationId}`],
  );
  let park = own.rows[0];
  if (!park) {
    const membership = await connection.query<{
      payload: { parkId: string; adminOrganizationId: string };
    }>(
      "SELECT payload FROM enterprise_business_records WHERE organization_id=$1 AND domain='park' AND resource_type='membership' AND resource_id=$2 AND status='active'",
      [organizationId, `membership_${organizationId}`],
    );
    if (membership.rows[0]) {
      const binding = membership.rows[0].payload;
      park = (
        await connection.query<Record<string, unknown>>(
          "SELECT resource_id,status,payload FROM enterprise_business_records WHERE organization_id=$1 AND domain='park' AND resource_type='park' AND resource_id=$2",
          [binding.adminOrganizationId, binding.parkId],
        )
      ).rows[0];
    }
  }
  const payload = park?.payload as { adminOrganizationId?: string } | undefined;
  return {
    accountId: String(row.id),
    organizationId,
    organizationName: String(row.organization_name),
    displayName: String(row.name),
    parkId: park?.status === 'active' ? String(park.resource_id) : null,
    active: row.status === 'active' && row.organization_status === 'active',
    parkServiceEnabled: row.park_services === true,
    parkAdmin:
      row.is_admin === true && payload?.adminOrganizationId === organizationId,
  };
}
