import { pruneCarpoolWorkflow } from './parkCarpoolRetention.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import {
  emptyCarpoolWorkflow,
  type CarpoolWorkflowState,
} from './parkCarpoolWorkflow.js';
import { createHash } from 'node:crypto';
import type { PublicationRecord } from './parkCarpoolPublication.js';
import type {
  PostgresEnterpriseBusinessRepository,
  PostgresBusinessRecord,
} from '../../enterprise/postgresBusinessRepository.js';
import type { EncryptedFieldValue } from '../data_platform/index.js';
import type { ParkCarpoolIntent } from './parkCarpoolDomain.js';
import type {
  ParkCarpoolStore,
  ParkCarpoolPrincipal,
} from './parkCarpoolService.js';

type Repository = Pick<
  PostgresEnterpriseBusinessRepository,
  | 'maintainCarpoolRecords'
  | 'transactCarpoolWorkflow'
  | 'saveCarpoolIntentAtomically'
  | 'getBusinessRecord'
  | 'listBusinessRecords'
  | 'createBusinessRecord'
  | 'updateBusinessRecord'
  | 'listParkCarpoolIntentRecords'
  | 'encryptBusinessSensitiveText'
  | 'decryptBusinessSensitiveText'
>;

type ClusteredCarpoolPayload = {
  parkId: string;
  travelDate: string;
  departureTime: string;
  flexibleMinutes: number;
  travelOptions: ParkCarpoolIntent['travelOptions'];
  routeDistanceMeters: number;
  routeDurationSeconds: number;
  sensitive: EncryptedFieldValue;
  lastConfirmedAt: string;
  expiresAt: string;
  createdAt: string;
};

type ClusteredCarpoolSensitive = Pick<
  ParkCarpoolIntent,
  'origin' | 'destination' | 'route' | 'requestKey' | 'requestHash'
>;

function carpoolEncryptionContext(intentId: string, accountId: string): string {
  return `park-carpool:v1:${intentId}:${accountId}`;
}

export function createParkCarpoolPostgresStore(input: {
  repository: Repository;
  getPrincipal(accountId: string): Promise<ParkCarpoolPrincipal | null>;
}): ParkCarpoolStore {
  async function clusteredCarpoolIntentFromRecord(
    record: PostgresBusinessRecord<ClusteredCarpoolPayload>,
    suppliedPrincipal?: ParkCarpoolPrincipal | null,
  ): Promise<ParkCarpoolIntent | null> {
    const accountId = record.ownerAccountId;
    if (!accountId) return null;
    const principal =
      suppliedPrincipal === undefined
        ? await input.getPrincipal(accountId)
        : suppliedPrincipal;
    if (
      !principal ||
      !principal.active ||
      !principal.parkServiceEnabled ||
      principal.parkId !== record.payload.parkId ||
      principal.organizationId !== record.organizationId
    )
      return null;
    const sensitive = JSON.parse(
      input.repository.decryptBusinessSensitiveText(
        record.payload.sensitive,
        carpoolEncryptionContext(record.resourceId, accountId),
      ),
    ) as ClusteredCarpoolSensitive;
    return {
      version: record.version,
      requestKey: sensitive.requestKey,
      requestHash: sensitive.requestHash,
      id: record.resourceId,
      accountId,
      organizationId: record.organizationId,
      organizationName: principal.organizationName,
      displayName: principal.displayName,
      parkId: record.payload.parkId,
      travelDate: record.payload.travelDate,
      origin: sensitive.origin,
      destination: sensitive.destination,
      departureTime: record.payload.departureTime,
      flexibleMinutes: record.payload.flexibleMinutes,
      travelOptions: record.payload.travelOptions,
      route: {
        ...sensitive.route,
        distanceMeters: record.payload.routeDistanceMeters,
        durationSeconds: record.payload.routeDurationSeconds,
      },
      status: record.status as ParkCarpoolIntent['status'],
      lastConfirmedAt: record.payload.lastConfirmedAt,
      expiresAt: record.payload.expiresAt,
      createdAt: record.payload.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function publicationIdentity(
    organizationId: string,
    accountId: string,
    key: string,
  ) {
    return {
      organizationId,
      domain: 'park' as const,
      resourceType: 'carpool_publication',
      resourceId: createHash('sha256')
        .update(`${accountId}:${key}`)
        .digest('hex'),
    };
  }
  return {
    maintain: (options) =>
      input.repository.maintainCarpoolRecords({
        ...options,
        rewriteWorkflow(parkId, encrypted, removed) {
          const state = JSON.parse(
            input.repository.decryptBusinessSensitiveText(
              JSON.parse(encrypted),
              `park-carpool-workflow:${parkId}`,
            ),
          ) as CarpoolWorkflowState;
          pruneCarpoolWorkflow(state, options.now, removed);
          return JSON.stringify(
            input.repository.encryptBusinessSensitiveText(
              JSON.stringify(state),
              `park-carpool-workflow:${parkId}`,
            ),
          );
        },
      }),
    async transactWorkflow(parkId, actorId, operation) {
      return input.repository.transactCarpoolWorkflow(
        parkId,
        actorId,
        async (encrypted, records, devices, principals) => {
          const state = encrypted
            ? (JSON.parse(
                input.repository.decryptBusinessSensitiveText(
                  JSON.parse(encrypted),
                  `park-carpool-workflow:${parkId}`,
                ),
              ) as CarpoolWorkflowState)
            : emptyCarpoolWorkflow();
          const decoded = await Promise.all(
            records.map((record) =>
              clusteredCarpoolIntentFromRecord(
                record as PostgresBusinessRecord<ClusteredCarpoolPayload>,
                principals.get(record.ownerAccountId!) ?? null,
              ),
            ),
          );
          const intents = decoded.filter(
            (intent): intent is ParkCarpoolIntent => intent !== null,
          );
          const stoppedIntentIds: string[] = [];
          const result = operation({
            state,
            actor: principals.get(actorId) ?? null,
            intents,
            stoppedIntentIds,
            devices: devices.filter((device) => {
              const principal = principals.get(device.accountId);
              return (
                principal?.active &&
                principal.parkServiceEnabled &&
                principal.parkId === parkId &&
                principal.organizationId === device.organizationId
              );
            }),
          });
          return {
            result,
            stoppedIntentIds,
            encrypted: JSON.stringify(
              input.repository.encryptBusinessSensitiveText(
                JSON.stringify(state),
                `park-carpool-workflow:${parkId}`,
              ),
            ),
          };
        },
      );
    },
    publications: {
      async readPublication(accountId, requestKey) {
        const actor = await input.getPrincipal(accountId);
        if (!actor?.active) throw new Error('当前账号不可用');
        const row = await input.repository.getBusinessRecord<{
          encrypted: EncryptedFieldValue;
        }>(publicationIdentity(actor.organizationId, accountId, requestKey));
        return row
          ? (JSON.parse(
              input.repository.decryptBusinessSensitiveText(
                row.payload.encrypted,
                `carpool-publication:${accountId}:${requestKey}`,
              ),
            ) as PublicationRecord)
          : null;
      },
      async writePublication(accountId, requestKey, record, expectedVersion) {
        const actor = await input.getPrincipal(accountId);
        if (!actor?.active) throw new Error('当前账号不可用');
        const identity = publicationIdentity(
          actor.organizationId,
          accountId,
          requestKey,
        );
        const payload = {
          expiresAt:
            record.receipt?.expiresAt ??
            new Date(Date.now() + 86400_000).toISOString(),
          encrypted: input.repository.encryptBusinessSensitiveText(
            JSON.stringify(record),
            `carpool-publication:${accountId}:${requestKey}`,
          ),
        };
        if (expectedVersion !== null)
          return Boolean(
            await input.repository.updateBusinessRecord({
              ...identity,
              expectedVersion,
              status: record.receipt ? 'complete' : 'pending',
              payload,
            }),
          );
        try {
          await input.repository.createBusinessRecord({
            ...identity,
            ownerAccountId: accountId,
            payload,
          });
          return true;
        } catch (error) {
          if ((error as { code?: string }).code === '23505') return false;
          throw error;
        }
      },
    },
    getPrincipal(accountId) {
      return input.getPrincipal(accountId);
    },
    async getIntent(accountId, travelDate) {
      const account = await input.getPrincipal(accountId);
      if (!account) return null;
      const records =
        await input.repository.listBusinessRecords<ClusteredCarpoolPayload>({
          organizationId: account.organizationId,
          domain: 'park',
          resourceType: 'carpool_intent',
          ownerAccountId: accountId,
          statuses: ['active', 'paused', 'grouped', 'expired'],
          limit: 30,
        });
      const record = records.find(
        (candidate) =>
          !travelDate || candidate.payload.travelDate === travelDate,
      );
      return record ? clusteredCarpoolIntentFromRecord(record) : null;
    },
    async listIntentPage(parkId, travelDate, afterId, limit = 200) {
      const records =
        await input.repository.listParkCarpoolIntentRecords<ClusteredCarpoolPayload>(
          {
            parkId,
            travelDate,
            statuses: ['active'],
            limit,
            afterId,
          },
        );
      const decoded = await Promise.allSettled(
        records.map((record) => clusteredCarpoolIntentFromRecord(record)),
      );
      const intents = decoded.flatMap((result) =>
        result.status === 'fulfilled' && result.value?.parkId === parkId
          ? [result.value]
          : [],
      );
      return {
        intents,
        failedCount: decoded.filter((result) => result.status === 'rejected')
          .length,
        nextCursor:
          records.length === limit ? records.at(-1)!.resourceId : undefined,
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
      const sensitive = input.repository.encryptBusinessSensitiveText(
        JSON.stringify({
          requestKey: intent.requestKey,
          requestHash: intent.requestHash,
          origin: intent.origin,
          destination: intent.destination,
          route: intent.route,
        } satisfies ClusteredCarpoolSensitive),
        carpoolEncryptionContext(intent.id, intent.accountId),
      );
      const payload: ClusteredCarpoolPayload = {
        parkId: intent.parkId,
        travelDate: intent.travelDate,
        departureTime: intent.departureTime,
        flexibleMinutes: intent.flexibleMinutes,
        travelOptions: intent.travelOptions,
        routeDistanceMeters: intent.route.distanceMeters,
        routeDurationSeconds: intent.route.durationSeconds,
        sensitive,
        lastConfirmedAt: intent.lastConfirmedAt,
        expiresAt: intent.expiresAt,
        createdAt: intent.createdAt,
      };
      const saved = await input.repository.saveCarpoolIntentAtomically({
        organizationId: intent.organizationId,
        accountId: intent.accountId,
        resourceId: intent.id,
        status: intent.status,
        payload,
        expectedVersion,
        publication: publication
          ? {
              resourceId: publicationIdentity(
                intent.organizationId,
                intent.accountId,
                publication.key,
              ).resourceId,
              expectedVersion: publication.record.version,
              completePayload: (row) => ({
                expiresAt: intent.expiresAt,
                encrypted: input.repository.encryptBusinessSensitiveText(
                  JSON.stringify({
                    ...publication.record,
                    version: publication.record.version + 1,
                    receipt: {
                      ...intent,
                      version: row.version,
                      updatedAt: row.updatedAt,
                    },
                  }),
                  `carpool-publication:${intent.accountId}:${publication.key}`,
                ),
              }),
            }
          : undefined,
      });
      return (await clusteredCarpoolIntentFromRecord(saved))!;
    },
    async stopIntent(accountId, intentId, _stoppedAt) {
      const account = await input.getPrincipal(accountId);
      if (!account) return null;
      const identity = {
        organizationId: account.organizationId,
        domain: 'park' as const,
        resourceType: 'carpool_intent',
        resourceId: intentId,
      };
      const current =
        await input.repository.getBusinessRecord<ClusteredCarpoolPayload>(
          identity,
        );
      if (!current || current.ownerAccountId !== accountId) return null;
      if (current.status === 'paused')
        return clusteredCarpoolIntentFromRecord(current);
      if (current.status !== 'active') return null;
      const saved = await input.repository.updateBusinessRecord({
        ...identity,
        expectedVersion: current.version,
        status: 'paused',
        payload: { ...current.payload },
      });
      return saved ? clusteredCarpoolIntentFromRecord(saved) : null;
    },
  };
}
