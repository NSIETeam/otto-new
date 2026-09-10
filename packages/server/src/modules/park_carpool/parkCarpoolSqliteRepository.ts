import { pruneCarpoolWorkflow, carpoolWorkflowAccountScopes, advanceCarpoolMaintenanceCursor, CARPOOL_BACKGROUND, CarpoolMaintenanceDeferred, type CarpoolMaintenanceCursor } from './parkCarpoolRetention.js';
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
import {
  emptyCarpoolWorkflow,
  type CarpoolWorkflowState,
} from './parkCarpoolWorkflow.js';
import type { PublicationRecord } from './parkCarpoolPublication.js';
import type {
  ParkCarpoolPrincipal,
  ParkCarpoolStore,
} from './parkCarpoolService.js';

interface CarpoolIntentRow {
  version: number;
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
  requestKey?: string;
  requestHash?: string;
  origin: ParkCarpoolIntent['origin'];
  destination: ParkCarpoolIntent['destination'];
  route: ParkCarpoolIntent['route'];
}

function encryptionContext(
  row: Pick<CarpoolIntentRow, 'id' | 'account_id'>,
): string {
  return `park-carpool:v1:${row.id}:${row.account_id}`;
}

function travelOptions(value: string): ParkCarpoolTravelOption[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(PARK_CARPOOL_TRAVEL_OPTIONS);
    return [
      ...new Set(
        parsed.filter(
          (item): item is ParkCarpoolTravelOption =>
            typeof item === 'string' && allowed.has(item),
        ),
      ),
    ];
  } catch {
    return [];
  }
}

export function createParkCarpoolSqliteStore(input: {
  db(): Database;
  fieldCipher: EncryptedFieldCipher;
  getPrincipal(accountId: string): ParkCarpoolPrincipal | null;
}): ParkCarpoolStore {
  let maintenanceCursors: Record<string, CarpoolMaintenanceCursor> = {};
  function toIntent(row: CarpoolIntentRow): ParkCarpoolIntent | null {
    const principal = input.getPrincipal(row.account_id);
    if (
      !principal?.active ||
      !principal.parkServiceEnabled ||
      principal.parkId !== row.park_id ||
      principal.organizationId !== row.organization_id
    )
      return null;
    const encrypted: EncryptedFieldValue = {
      ciphertext: row.sensitive_ciphertext,
      iv: row.sensitive_iv,
      authTag: row.sensitive_auth_tag,
      keyVersion: Number(row.sensitive_key_version),
    };
    const sensitive = JSON.parse(
      input.fieldCipher.decryptText(encrypted, encryptionContext(row)),
    ) as SensitiveIntentFields;
    return {
      version: Number(row.version),
      requestKey: sensitive.requestKey,
      requestHash: sensitive.requestHash,
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
    async maintain(options) {
      const database = input.db();
      const cursors = structuredClone(maintenanceCursors);
      // SQL identifiers are fixed internal call sites, never request input.
      const page = (table: string, columns: string[], limit: number) => {
        if (options.deleteAccountId) return database.prepare(`SELECT * FROM ${table} ORDER BY ${columns.join(',')}`).all();
        const cursor = cursors[table] ??= {};
        const tuple = columns.length === 1 ? columns[0] : `(${columns.join(',')})`;
        const marks = columns.length === 1 ? '?' : `(${columns.map(() => '?').join(',')})`;
        if (!cursor.end) {
          const high = database.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY ${columns.map(key => `${key} DESC`).join(',')} LIMIT 1`).get() as Record<string, string> | undefined;
          if (!high) return [];
          cursor.end = columns.map(key => high[key]);
        }
        const projection = table === 'park_carpool_workflow' ? `park_id, CASE WHEN length(CAST(encrypted_payload AS BLOB))<=${CARPOOL_BACKGROUND.workflowBytes} THEN encrypted_payload END AS encrypted_payload` : '*';
        const rows = database.prepare(`SELECT ${projection} FROM ${table} WHERE ${tuple} <= ${marks}${cursor.after ? ` AND ${tuple} > ${marks}` : ''} ORDER BY ${columns.join(',')} LIMIT ?`).all(...cursor.end, ...(cursor.after ?? []), limit) as Array<Record<string, string>>;
        advanceCarpoolMaintenanceCursor(cursor, rows.map(row => columns.map(key => row[key])), limit);
        return rows;
      };
      database.exec('SAVEPOINT carpool_maintenance');
      try {
        const cutoff =
          Date.parse(options.now) - options.positionRetentionHours * 3600_000;
        const rows = page('park_carpool_intents', ['id'], 4) as unknown as CarpoolIntentRow[];
        const removed = new Set<string>(
          options.deleteAccountId ? [options.deleteAccountId] : [],
        );
        const accountIds = new Set<string>();
        let deletedPositions = 0;
        const removedByPark = new Map<string, Set<string>>();
        for (const row of rows) {
          const principal = input.getPrincipal(row.account_id);
          if (!principal?.active || !principal.parkServiceEnabled)
            removed.add(row.account_id);
          const invalidScope =
            principal?.parkId !== row.park_id ||
            principal?.organizationId !== row.organization_id;
          if (invalidScope && principal?.parkId !== row.park_id) {
            const ids = removedByPark.get(row.park_id) ?? new Set<string>();
            ids.add(row.account_id);
            removedByPark.set(row.park_id, ids);
          }
          if (
            removed.has(row.account_id) ||
            invalidScope ||
            Date.parse(row.expires_at) <= cutoff
          ) {
            database
              .prepare('DELETE FROM park_carpool_intents WHERE id=?')
              .run(row.id);
            deletedPositions += 1;
          } else {
            accountIds.add(row.account_id);
            if (
              row.status === 'active' &&
              Date.parse(row.expires_at) <= Date.parse(options.now)
            )
              database
                .prepare(
                  "UPDATE park_carpool_intents SET status='expired',version=version+1,updated_at=? WHERE id=?",
                )
                .run(options.now, row.id);
          }
        }
        const publications = page('park_carpool_publications', ['account_id', 'request_key'], 32) as Array<{
          account_id: string;
          request_key: string;
          encrypted_payload: string;
        }>;
        for (const row of publications) {
          const actor = input.getPrincipal(row.account_id);
          const record = JSON.parse(
            input.fieldCipher.decryptText(
              JSON.parse(row.encrypted_payload),
              `carpool-publication:${row.account_id}:${row.request_key}`,
            ),
          ) as PublicationRecord;
          if (
            removed.has(row.account_id) ||
            !actor?.active || !actor.parkServiceEnabled ||
            (record.receipt &&
              (record.receipt.parkId !==
                actor.parkId ||
                record.receipt.organizationId !==
                  actor.organizationId)) ||
            (record.receipt
              ? Date.parse(record.receipt.expiresAt)
              : record.leaseUntil) < cutoff
          )
            database
              .prepare(
                'DELETE FROM park_carpool_publications WHERE account_id=? AND request_key=?',
              )
              .run(row.account_id, row.request_key);
        }
        const workflows = page('park_carpool_workflow', ['park_id'], 4) as Array<{ park_id: string; encrypted_payload: string }>;
        const deferred: Array<{ parkId: string; reason: string }> = [];
        for (const row of workflows) {
          if (row.encrypted_payload === null) { deferred.push({ parkId: row.park_id, reason: 'workflow_bytes' }); continue; }
          const state = JSON.parse(
            input.fieldCipher.decryptText(
              JSON.parse(row.encrypted_payload),
              `park-carpool-workflow:${row.park_id}`,
            ),
          ) as CarpoolWorkflowState;
          const before = JSON.stringify(state);
          const scopes = carpoolWorkflowAccountScopes(state);
          if (!options.deleteAccountId && scopes.size > CARPOOL_BACKGROUND.principals) { deferred.push({ parkId: row.park_id, reason: 'workflow_principals' }); continue; }
          const revoked = [...scopes].filter(([id, organizations]) => {
            const actor = input.getPrincipal(id);
            return !actor?.active || !actor.parkServiceEnabled || actor.parkId !== row.park_id || [...organizations].some(org => org !== actor.organizationId);
          }).map(([id]) => id);
          pruneCarpoolWorkflow(state, options.now, [
            ...removed,
            ...(removedByPark.get(row.park_id) ?? []),
            ...revoked,
          ], options.communicationRetentionDays);
          if (JSON.stringify(state) === before) continue;
          database
            .prepare(
              'UPDATE park_carpool_workflow SET encrypted_payload=?,version=version+1 WHERE park_id=?',
            )
            .run(
              JSON.stringify(
                input.fieldCipher.encryptText(
                  JSON.stringify(state),
                  `park-carpool-workflow:${row.park_id}`,
                ),
              ),
              row.park_id,
            );
        }
        database.exec('RELEASE carpool_maintenance');
        if (!options.deleteAccountId) maintenanceCursors = cursors;
        return {
          accountIds: [...accountIds].filter((id) => !removed.has(id)),
          deletedPositions,
          deferred,
          checkedParkIds: workflows.map(row => row.park_id),
          scanned: { intents: rows.length, publications: publications.length, workflows: workflows.length },
        };
      } catch (error) {
        database.exec('ROLLBACK TO carpool_maintenance');
        database.exec('RELEASE carpool_maintenance');
        throw error;
      }
    },
    async transactWorkflow(parkId, actorId, operation, maintenance = false) {
      const database = input.db();
      database.exec('SAVEPOINT carpool_workflow');
      try {
        const row = database
          .prepare(
            maintenance ? `SELECT CASE WHEN length(CAST(encrypted_payload AS BLOB))<=${CARPOOL_BACKGROUND.workflowBytes} THEN encrypted_payload END AS encrypted_payload FROM park_carpool_workflow WHERE park_id=?` : 'SELECT encrypted_payload FROM park_carpool_workflow WHERE park_id = ?',
          )
          .get(parkId) as { encrypted_payload: string } | undefined;
        if (maintenance && row?.encrypted_payload === null) throw new CarpoolMaintenanceDeferred(parkId, 'workflow_bytes');
        const state = row
          ? (JSON.parse(
              input.fieldCipher.decryptText(
                JSON.parse(row.encrypted_payload),
                `park-carpool-workflow:${parkId}`,
              ),
            ) as CarpoolWorkflowState)
          : emptyCarpoolWorkflow();
        const before = JSON.stringify(state);
        if (maintenance && carpoolWorkflowAccountScopes(state).size > CARPOOL_BACKGROUND.principals) throw new CarpoolMaintenanceDeferred(parkId, 'workflow_principals');
        const rows = database
          .prepare(`SELECT * FROM park_carpool_intents WHERE park_id = ?${maintenance ? ` LIMIT ${CARPOOL_BACKGROUND.intents + 1}` : ''}`)
          .all(parkId) as CarpoolIntentRow[];
        if (maintenance && rows.length > CARPOOL_BACKGROUND.intents) throw new CarpoolMaintenanceDeferred(parkId, 'park_intents');
        const intents = rows.flatMap((value) => {
          const intent = toIntent(value);
          return intent ? [intent] : [];
        });
        const hasDevices = database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='e2ee_devices'",
          )
          .get();
        const deviceAccounts = maintenance ? [...new Set([actorId, ...intents.map(intent => intent.accountId)])] : [];
        const deviceRows = hasDevices
          ? (
              database
                .prepare(
                  `SELECT * FROM e2ee_devices WHERE approval_state='approved' AND revoked_at IS NULL${maintenance ? ` AND account_id IN (${deviceAccounts.map(() => '?').join(',')}) LIMIT ${CARPOOL_BACKGROUND.devices + 1}` : ''}`,
                )
                .all(...deviceAccounts) as Array<{
                organization_id: string;
                account_id: string;
                device_id: string;
                identity_signing_public_key?: string;
              }>
            ) : [];
        if (maintenance && deviceRows.length > CARPOOL_BACKGROUND.devices) throw new CarpoolMaintenanceDeferred(parkId, 'approved_devices');
        const devices = deviceRows
              .filter((d) => {
                const principal = input.getPrincipal(d.account_id);
                return (
                  principal?.active &&
                  principal.parkServiceEnabled &&
                  principal.parkId === parkId &&
                  principal.organizationId === d.organization_id
                );
              })
              .map((d) => ({
                organizationId: d.organization_id,
                accountId: d.account_id,
                deviceId: d.device_id,
                identitySigningPublicKey: d.identity_signing_public_key,
              }));
        const stoppedIntentIds: string[] = [];
        const result = operation({
          state,
          actor: input.getPrincipal(actorId),
          intents,
          stoppedIntentIds,
          devices,
        });
        for (const intentId of stoppedIntentIds)
          database
            .prepare(
              "UPDATE park_carpool_intents SET status='paused',version=version+1,updated_at=? WHERE id=? AND account_id=? AND park_id=? AND status='active'",
            )
            .run(new Date().toISOString(), intentId, actorId, parkId);
        if (!row || JSON.stringify(state) !== before) {
          const encrypted = input.fieldCipher.encryptText(
          JSON.stringify(state),
          `park-carpool-workflow:${parkId}`,
        );
        database
          .prepare(
            `INSERT INTO park_carpool_workflow(park_id, encrypted_payload) VALUES (?, ?)
          ON CONFLICT(park_id) DO UPDATE SET encrypted_payload=excluded.encrypted_payload, version=park_carpool_workflow.version+1`,
          )
          .run(parkId, JSON.stringify(encrypted));
        }
        database.exec('RELEASE carpool_workflow');
        return result;
      } catch (error) {
        database.exec('ROLLBACK TO carpool_workflow');
        database.exec('RELEASE carpool_workflow');
        throw error;
      }
    },
    publications: {
      async readPublication(accountId, requestKey) {
        const row = input
          .db()
          .prepare(
            'SELECT encrypted_payload FROM park_carpool_publications WHERE account_id = ? AND request_key = ?',
          )
          .get(accountId, requestKey) as
          { encrypted_payload: string } | undefined;
        return row
          ? (JSON.parse(
              input.fieldCipher.decryptText(
                JSON.parse(row.encrypted_payload),
                `carpool-publication:${accountId}:${requestKey}`,
              ),
            ) as PublicationRecord)
          : null;
      },
      async writePublication(accountId, requestKey, record, expectedVersion) {
        const encrypted = input.fieldCipher.encryptText(
          JSON.stringify(record),
          `carpool-publication:${accountId}:${requestKey}`,
        );
        const result = input
          .db()
          .prepare(
            `INSERT INTO park_carpool_publications(account_id, request_key, version, encrypted_payload) VALUES (?, ?, ?, ?)
          ON CONFLICT(account_id, request_key) DO UPDATE SET version=excluded.version, encrypted_payload=excluded.encrypted_payload
          WHERE park_carpool_publications.version = ?`,
          )
          .run(
            accountId,
            requestKey,
            record.version,
            JSON.stringify(encrypted),
            expectedVersion ?? -1,
          );
        return Number(result.changes) === 1;
      },
    },
    async getPrincipal(accountId) {
      return input.getPrincipal(accountId);
    },
    async getIntent(accountId, travelDate) {
      const row = input
        .db()
        .prepare(
          `SELECT * FROM park_carpool_intents
         WHERE account_id = ? ${travelDate ? 'AND travel_date = ?' : ''}
         ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(...(travelDate ? [accountId, travelDate] : [accountId])) as
        CarpoolIntentRow | undefined;
      return row ? toIntent(row) : null;
    },
    async listIntentPage(parkId, travelDate, afterId = '', limit = 200) {
      const pageSize = Math.max(1, Math.min(500, Math.floor(limit)));
      const rows = input
        .db()
        .prepare(
          `SELECT * FROM park_carpool_intents
         WHERE park_id = ? AND travel_date = ? AND status = 'active' AND id > ?
         ORDER BY id LIMIT ?`,
        )
        .all(parkId, travelDate, afterId, pageSize) as CarpoolIntentRow[];
      let failedCount = 0;
      const intents = rows.flatMap((row) => {
        const principal = input.getPrincipal(row.account_id);
        if (
          !principal?.active ||
          !principal.parkServiceEnabled ||
          principal.parkId !== parkId ||
          principal.organizationId !== row.organization_id
        )
          return [];
        try {
          const decoded = toIntent(row);
          return decoded ? [decoded] : [];
        } catch {
          failedCount += 1;
          return [];
        }
      });
      return {
        intents,
        failedCount,
        nextCursor: rows.length === pageSize ? rows.at(-1)!.id : undefined,
      };
    },
    async listActiveIntents(parkId, travelDate) {
      const intents: ParkCarpoolIntent[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.listIntentPage!(parkId, travelDate, cursor);
        intents.push(...page.intents);
        cursor = page.nextCursor;
      } while (cursor);
      return intents;
    },
    async saveIntent(intent, expectedVersion, publication) {
      const database = input.db();
      database.exec('SAVEPOINT carpool_publication');
      try {
        const encrypted = input.fieldCipher.encryptText(
          JSON.stringify({
            requestKey: intent.requestKey,
            requestHash: intent.requestHash,
            origin: intent.origin,
            destination: intent.destination,
            route: intent.route,
          } satisfies SensitiveIntentFields),
          encryptionContext({
            id: intent.id,
            account_id: intent.accountId,
          }),
        );
        const result = input
          .db()
          .prepare(
            `INSERT INTO park_carpool_intents (
           id, account_id, organization_id, park_id, travel_date,
           departure_time, flexible_minutes, travel_options,
           route_distance_meters, route_duration_seconds, status,
           sensitive_ciphertext, sensitive_iv, sensitive_auth_tag,
           sensitive_key_version, last_confirmed_at, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, travel_date) DO UPDATE SET
           version = park_carpool_intents.version + 1,
           organization_id = excluded.organization_id,
           park_id = excluded.park_id,
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
           updated_at = excluded.updated_at
         WHERE ? = 1 OR park_carpool_intents.version = ?`,
          )
          .run(
            intent.id,
            intent.accountId,
            intent.organizationId,
            intent.parkId,
            intent.travelDate,
            intent.departureTime,
            intent.flexibleMinutes,
            JSON.stringify(intent.travelOptions),
            intent.route.distanceMeters,
            intent.route.durationSeconds,
            intent.status,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.authTag,
            encrypted.keyVersion,
            intent.lastConfirmedAt,
            intent.expiresAt,
            intent.createdAt,
            intent.updatedAt,
            expectedVersion === undefined ? 1 : 0,
            expectedVersion ?? -1,
          );
        if (Number(result.changes) !== 1)
          throw new Error('同行意向已被其他操作更新，请重试');
        const row = database
          .prepare(
            'SELECT * FROM park_carpool_intents WHERE account_id = ? AND travel_date = ?',
          )
          .get(intent.accountId, intent.travelDate) as CarpoolIntentRow;
        const saved = toIntent(row);
        if (!saved) throw new Error('当前账号不可用');
        if (publication) {
          const receipt = {
            ...publication.record,
            version: publication.record.version + 1,
            receipt: saved,
          };
          const encryptedReceipt = input.fieldCipher.encryptText(
            JSON.stringify(receipt),
            `carpool-publication:${intent.accountId}:${publication.key}`,
          );
          const updated = database
            .prepare(
              'UPDATE park_carpool_publications SET version = ?, encrypted_payload = ? WHERE account_id = ? AND request_key = ? AND version = ?',
            )
            .run(
              receipt.version,
              JSON.stringify(encryptedReceipt),
              intent.accountId,
              publication.key,
              publication.record.version,
            );
          if (Number(updated.changes) !== 1)
            throw new Error('发布请求已被其他操作更新');
        }
        database.exec('RELEASE carpool_publication');
        return saved;
      } catch (error) {
        database.exec('ROLLBACK TO carpool_publication');
        database.exec('RELEASE carpool_publication');
        throw error;
      }
    },
    async stopIntent(accountId, intentId, stoppedAt) {
      const result = input
        .db()
        .prepare(
          `UPDATE park_carpool_intents
         SET status = 'paused', version = version + 1, updated_at = ?
         WHERE id = ? AND account_id = ? AND status = 'active'`,
        )
        .run(stoppedAt, intentId, accountId);
      if (Number(result.changes) !== 1) {
        const existing = input
          .db()
          .prepare(
            "SELECT * FROM park_carpool_intents WHERE id = ? AND account_id = ? AND status = 'paused'",
          )
          .get(intentId, accountId) as CarpoolIntentRow | undefined;
        return existing ? toIntent(existing) : null;
      }
      const row = input
        .db()
        .prepare(
          'SELECT * FROM park_carpool_intents WHERE id = ? AND account_id = ?',
        )
        .get(intentId, accountId) as CarpoolIntentRow | undefined;
      return row ? toIntent(row) : null;
    },
  };
}
