import { selectedMarketMessageEvidence } from './fleaMarketMessageEvidence.js';
import { endMarketListingRequests } from './fleaMarketContacts.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { MarketServiceDependencies } from './fleaMarketService.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
import { MarketError, type Listing } from './fleaMarketTypes.js';
import {
  canDiscover,
  canModerate,
  publicListing,
  requireActive,
  samePark,
} from './fleaMarketAccess.js';
import { textField } from './fleaMarketValidation.js';
import { createMarketUnitOfWork } from './fleaMarketUnitOfWork.js';
export function createMarketModeration(deps: MarketServiceDependencies) {
  const now = deps.now ?? Date.now;
  const unit = createMarketUnitOfWork(
    deps.repository,
    deps.cipher,
    async (tx, account) => {
      requireActive(await deps.principal(tx, account));
    },
  );
  const encode = (value: unknown, context: string) =>
    JSON.stringify(deps.cipher.encryptText(JSON.stringify(value), context));
  const decode = (value: unknown, context: string) =>
    JSON.parse(deps.cipher.decryptText(JSON.parse(String(value)), context));
  const event = async (
    tx: MarketTransaction,
    id: string,
    account: string,
    kind: string,
    object: string,
    version: number,
  ) => {
    await tx.run(
      'INSERT INTO park_market_outbox(id,account_id,kind,object_id,object_version,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      [id, account, kind, object, version, now()],
    );
  };
  return {
    async report(
      accountId: string,
      listingId: string,
      input: Record<string, unknown>,
    ): Promise<{ id: string; version: number }> {
      return unit.execute(
        accountId,
        String(input.requestId ?? ''),
        { action: 'report', listingId, input },
        async (tx) => {
          const actor = await deps.principal(tx, accountId);
          requireActive(actor);
          const [row] = await tx.all(
            'SELECT * FROM park_market_listings WHERE id=?',
            [listingId],
          );
          if (!row) throw new MarketError('NOT_FOUND');
          const listing: Listing = decode(
            row.payload,
            `park-market-listing:${listingId}`,
          );
          if (!samePark(actor, listing.parkId))
            throw new MarketError('NOT_FOUND');
          const selectedMessages = await selectedMarketMessageEvidence(
            deps,
            tx,
            accountId,
            listingId,
            listing.parkId,
            input.selectedMessages,
          );
          if (
            !selectedMessages.length &&
            (!canDiscover(
              actor,
              await deps.config(tx, listing.parkId),
              listing.parkId,
            ) ||
              !samePark(
                await deps.principal(tx, listing.ownerId),
                listing.parkId,
              ) ||
              !['active', 'reserved'].includes(listing.state) ||
              listing.expiresAt <= now())
          )
            throw new MarketError('NOT_FOUND');
          const [pending] = await tx.all(
            'SELECT id,version FROM park_market_reports WHERE reporter_id=? AND object_id=? AND closed_at IS NULL',
            [accountId, listingId],
          );
          if (pending)
            return { id: String(pending.id), version: Number(pending.version) };
          if (
            ![
              'misleading',
              'advertising',
              'fraud',
              'inappropriate',
              'harassment',
              'other',
            ].includes(String(input.reason))
          )
            throw new MarketError('INVALID_INPUT', 'reason');
          const description = textField(
            input.description ?? '',
            'description',
            input.reason === 'other' ? 1 : 0,
            500,
          );
          const evidenceIds = input.evidenceIds ?? [];
          if (
            !Array.isArray(evidenceIds) ||
            evidenceIds.length > 3 ||
            evidenceIds.some((id) => typeof id !== 'string')
          )
            throw new MarketError('INVALID_INPUT', 'evidenceIds');
          for (const id of evidenceIds) {
            const [image] = await tx.all(
              'SELECT * FROM park_market_images WHERE id=?',
              [id],
            );
            if (
              !image ||
              image.owner_id !== accountId ||
              image.park_id !== listing.parkId ||
              image.state !== 'available'
            )
              throw new MarketError('NOT_FOUND', 'evidenceIds');
          }
          const id = randomUUID();
          const payload = {
            reason: input.reason,
            description,
            evidenceIds,
            selectedMessages,
            snapshot:
              ['removed', 'deleted'].includes(listing.state) ||
              listing.cleanedAt !== null
                ? {
                    id: listing.id,
                    title: listing.title,
                    saleMode: listing.saleMode,
                    state: listing.state,
                    imageIds: [],
                  }
                : publicListing(listing),
            decisions: [],
          };
          await tx.run(
            'INSERT INTO park_market_reports(id,park_id,reporter_id,object_id,state,version,created_at,payload) VALUES (?,?,?,?,?,?,?,?)',
            [
              id,
              listing.parkId,
              accountId,
              listingId,
              'pending',
              1,
              now(),
              encode(payload, `park-market-report:${id}`),
            ],
          );
          for (const imageId of new Set([
            ...(['removed', 'deleted'].includes(listing.state)
              ? []
              : listing.imageIds),
            ...evidenceIds,
          ]))
            await tx.run(
              "INSERT INTO park_market_image_refs VALUES (?,'evidence',?,?,NULL)",
              [imageId, id, accountId],
            );
          await event(
            tx,
            `${id}:accepted`,
            accountId,
            'report-accepted',
            id,
            1,
          );
          return { id, version: 1 };
        },
      );
    },
    async decide(
      accountId: string,
      id: string,
      input: Record<string, unknown>,
    ): Promise<void> {
      const decisionUnit = createMarketUnitOfWork(
        deps.repository,
        deps.cipher,
        async (tx, actorId) => {
          const actor = await deps.principal(tx, actorId);
          requireActive(actor);
          const [report] = await tx.all(
            'SELECT park_id FROM park_market_reports WHERE id=?',
            [id],
          );
          if (!report || !canModerate(actor, String(report.park_id)))
            throw new MarketError('FORBIDDEN');
        },
      );
      await decisionUnit.execute(
        accountId,
        String(input.requestId ?? ''),
        { action: 'decide', id, input },
        async (tx) => {
          const actor = await deps.principal(tx, accountId);
          requireActive(actor);
          const [report] = await tx.all(
            'SELECT * FROM park_market_reports WHERE id=?',
            [id],
          );
          if (!report || !canModerate(actor, String(report.park_id)))
            throw new MarketError('FORBIDDEN');
          if (
            Number(report.version) !== input.expectedVersion ||
            report.closed_at !== null
          )
            throw new MarketError('CONFLICT');
          if (
            !['remove', 'dismiss', 'processing'].includes(
              String(input.decision),
            )
          )
            throw new MarketError('INVALID_INPUT', 'decision');
          const reason = textField(input.reason, 'reason', 2, 500);
          const payload = decode(report.payload, `park-market-report:${id}`);
          payload.decisions.push({
            actorId: accountId,
            decision: input.decision,
            reason,
            at: now(),
          });
          const auditId = randomUUID();
          await tx.run('INSERT INTO park_market_audit VALUES (?,?,?,?,?,?,?)', [
            auditId,
            report.park_id,
            accountId,
            id,
            `report-${input.decision}`,
            now(),
            encode(
              { reason, listingId: report.object_id },
              `park-market-audit:${auditId}`,
            ),
          ]);
          if (input.decision === 'processing') {
            if (report.state !== 'pending') throw new MarketError('CONFLICT');
            await tx.run(
              "UPDATE park_market_reports SET state='processing',version=version+1,payload=? WHERE id=?",
              [encode(payload, `park-market-report:${id}`), id],
            );
            return { id, version: Number(report.version) + 1 };
          }
          if (input.decision === 'remove') {
            const [row] = await tx.all(
              'SELECT * FROM park_market_listings WHERE id=?',
              [report.object_id],
            );
            const listing: Listing = decode(
              row.payload,
              `park-market-listing:${row.id}`,
            );
            if (listing.state === 'deleted') throw new MarketError('CONFLICT');
            const next = {
              ...listing,
              state: 'removed',
              reservation: null,
              endedAt: listing.endedAt ?? now(),
              version: listing.version + 1,
              updatedAt: now(),
            };
            await endMarketListingRequests(tx, listing.id);
            const encoded = encode(next, `park-market-listing:${listing.id}`);
            await tx.run(
              'UPDATE park_market_listings SET state=?,version=?,updated_at=?,ended_at=?,payload=? WHERE id=? AND version=?',
              [
                'removed',
                next.version,
                now(),
                next.endedAt,
                encoded,
                listing.id,
                listing.version,
              ],
            );
            await tx.run(
              'INSERT INTO park_market_history VALUES (?,?,?,?,?,?,?)',
              [
                randomUUID(),
                listing.id,
                next.version,
                accountId,
                'moderation-remove',
                now(),
                encoded,
              ],
            );
            await event(
              tx,
              `${id}:removed`,
              listing.ownerId,
              'moderation-result',
              listing.id,
              next.version,
            );
          }
          await tx.run(
            'UPDATE park_market_reports SET state=?,version=version+1,closed_at=?,payload=? WHERE id=?',
            ['closed', now(), encode(payload, `park-market-report:${id}`), id],
          );
          await tx.run(
            "UPDATE park_market_image_refs SET expires_at=? WHERE kind='evidence' AND object_id=?",
            [now() + 180 * 86400000, id],
          );
          await event(
            tx,
            `${id}:closed`,
            String(report.reporter_id),
            'report-result',
            id,
            Number(report.version) + 1,
          );
          return { id, version: Number(report.version) + 1 };
        },
      );
    },
  };
}
