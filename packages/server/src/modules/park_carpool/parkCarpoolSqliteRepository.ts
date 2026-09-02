/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedFieldValue,
} from '../data_platform/index.js';
import {
  PARK_CARPOOL_TRAVEL_OPTIONS,
  type ParkCarpoolIntent,
  type ParkCarpoolIntentStatus,
  type ParkCarpoolTravelOption,
} from './parkCarpoolDomain.js';
import type {
  ParkCarpoolPrincipal,
  ParkCarpoolStore,
} from './parkCarpoolService.js';

interface CarpoolIntentRow {
  id: string;
  account_id: string;
  organization_id: string;
  park_id: string;
  travel_date: string;
  departure_time: string;
  flexible_minutes: number;
  travel_options: string;
  route_distance_meters: number;
  route_duration_seconds: number;
  status: ParkCarpoolIntentStatus;
  sensitive_ciphertext: string;
  sensitive_iv: string;
  sensitive_auth_tag: string;
  sensitive_key_version: number;
  last_confirmed_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface SensitiveIntentFields {
  origin: ParkCarpoolIntent['origin'];
  destination: ParkCarpoolIntent['destination'];
  route: ParkCarpoolIntent['route'];
}

function encryptionContext(row: Pick<CarpoolIntentRow, 'id' | 'account_id'>): string {
  return `park-carpool:v1:${row.id}:${row.account_id}`;
}

function travelOptions(value: string): ParkCarpoolTravelOption[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(PARK_CARPOOL_TRAVEL_OPTIONS);
    return [...new Set(parsed.filter(
      (item): item is ParkCarpoolTravelOption => typeof item === 'string' && allowed.has(item),
    ))];
  } catch {
    return [];
  }
}

export function createParkCarpoolSqliteStore(input: {
  db(): Database;
  fieldCipher: EncryptedFieldCipher;
  getPrincipal(accountId: string): ParkCarpoolPrincipal | null;
}): ParkCarpoolStore {
  function toIntent(row: CarpoolIntentRow): ParkCarpoolIntent | null {
    const principal = input.getPrincipal(row.account_id);
    if (!principal) return null;
    const encrypted: EncryptedFieldValue = {
      ciphertext: row.sensitive_ciphertext,
      iv: row.sensitive_iv,
      authTag: row.sensitive_auth_tag,
      keyVersion: Number(row.sensitive_key_version),
    };
    const sensitive = JSON.parse(input.fieldCipher.decryptText(
      encrypted,
      encryptionContext(row),
    )) as SensitiveIntentFields;
    return {
      id: row.id,
      accountId: row.account_id,
      organizationId: row.organization_id,
      organizationName: principal.organizationName,
      displayName: principal.displayName,
      parkId: row.park_id,
      travelDate: row.travel_date,
      origin: sensitive.origin,
      destination: sensitive.destination,
      departureTime: row.departure_time,
      flexibleMinutes: Number(row.flexible_minutes),
      travelOptions: travelOptions(row.travel_options),
      route: {
        ...sensitive.route,
        distanceMeters: Number(row.route_distance_meters),
        durationSeconds: Number(row.route_duration_seconds),
      },
      status: row.status,
      lastConfirmedAt: row.last_confirmed_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    async getPrincipal(accountId) {
      return input.getPrincipal(accountId);
    },
    async getIntent(accountId, travelDate) {
      const row = input.db().prepare(
        `SELECT * FROM park_carpool_intents
         WHERE account_id = ? ${travelDate ? 'AND travel_date = ?' : ''}
         ORDER BY updated_at DESC LIMIT 1`,
      ).get(...(travelDate ? [accountId, travelDate] : [accountId])) as
        | CarpoolIntentRow
        | undefined;
      return row ? toIntent(row) : null;
    },
    async listActiveIntents(parkId, travelDate) {
      const rows = input.db().prepare(
        `SELECT * FROM park_carpool_intents
         WHERE park_id = ? AND travel_date = ? AND status = 'active'
         ORDER BY departure_time, id
         LIMIT 500`,
      ).all(parkId, travelDate) as CarpoolIntentRow[];
      return rows.flatMap((row) => {
        const principal = input.getPrincipal(row.account_id);
        if (!principal?.active || !principal.parkServiceEnabled || principal.parkId !== parkId) return [];
        const decoded = toIntent(row);
        return decoded ? [decoded] : [];
      });
    },
    async saveIntent(intent) {
      const encrypted = input.fieldCipher.encryptText(JSON.stringify({
        origin: intent.origin,
        destination: intent.destination,
        route: intent.route,
      } satisfies SensitiveIntentFields), encryptionContext({
        id: intent.id,
        account_id: intent.accountId,
      }));
      input.db().prepare(
        `INSERT INTO park_carpool_intents (
           id, account_id, organization_id, park_id, travel_date,
           departure_time, flexible_minutes, travel_options,
           route_distance_meters, route_duration_seconds, status,
           sensitive_ciphertext, sensitive_iv, sensitive_auth_tag,
           sensitive_key_version, last_confirmed_at, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, travel_date) DO UPDATE SET
           departure_time = excluded.departure_time,
           flexible_minutes = excluded.flexible_minutes,
           travel_options = excluded.travel_options,
           route_distance_meters = excluded.route_distance_meters,
           route_duration_seconds = excluded.route_duration_seconds,
           status = excluded.status,
           sensitive_ciphertext = excluded.sensitive_ciphertext,
           sensitive_iv = excluded.sensitive_iv,
           sensitive_auth_tag = excluded.sensitive_auth_tag,
           sensitive_key_version = excluded.sensitive_key_version,
           last_confirmed_at = excluded.last_confirmed_at,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      ).run(
        intent.id, intent.accountId, intent.organizationId, intent.parkId,
        intent.travelDate, intent.departureTime, intent.flexibleMinutes,
        JSON.stringify(intent.travelOptions), intent.route.distanceMeters,
        intent.route.durationSeconds, intent.status, encrypted.ciphertext,
        encrypted.iv, encrypted.authTag, encrypted.keyVersion,
        intent.lastConfirmedAt, intent.expiresAt, intent.createdAt, intent.updatedAt,
      );
      return (await this.getIntent(intent.accountId, intent.travelDate))!;
    },
    async stopIntent(accountId, intentId, stoppedAt) {
      const result = input.db().prepare(
        `UPDATE park_carpool_intents
         SET status = 'paused', updated_at = ?
         WHERE id = ? AND account_id = ? AND status = 'active'`,
      ).run(stoppedAt, intentId, accountId);
      if (Number(result.changes) !== 1) return null;
      const row = input.db().prepare(
        'SELECT * FROM park_carpool_intents WHERE id = ? AND account_id = ?',
      ).get(intentId, accountId) as CarpoolIntentRow | undefined;
      return row ? toIntent(row) : null;
    },
  };
}
