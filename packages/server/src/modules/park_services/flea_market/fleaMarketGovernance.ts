import { endMarketListingRequests } from './fleaMarketContacts.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { MarketServiceDependencies } from './fleaMarketService.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
import { canModerate, requireActive } from './fleaMarketAccess.js';
import { MarketError, type Listing } from './fleaMarketTypes.js';
import { textField } from './fleaMarketValidation.js';
import { transitionListing } from './fleaMarketLifecycle.js';
import { createMarketUnitOfWork } from './fleaMarketUnitOfWork.js';

export const MARKET_GOVERNANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS park_market_audit (
 id TEXT PRIMARY KEY,park_id TEXT NOT NULL,actor_id TEXT NOT NULL,object_id TEXT NOT NULL,
 action TEXT NOT NULL,created_at BIGINT NOT NULL,payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS park_market_audit_park ON park_market_audit(park_id,created_at);
`;
type Input = Record<string, unknown>;
export function createMarketGovernance(deps: MarketServiceDependencies) {
  const now = deps.now ?? Date.now;
  const encode = (value: unknown, context: string) =>
    JSON.stringify(deps.cipher.encryptText(JSON.stringify(value), context));
  const decode = (value: unknown, context: string) =>
    JSON.parse(deps.cipher.decryptText(JSON.parse(String(value)), context));
  const unit = createMarketUnitOfWork(
    deps.repository,
    deps.cipher,
    async (tx, id, payload) => {
      requireActive(await deps.principal(tx, id));
      const operation = payload as {
        action: string;
        object: string;
        scope: string | null;
      };
      if (operation.action === 'appeal') return;
      if (operation.action === 'restrict')
        return admin(tx, id, operation.scope!);
      const table =
        operation.action === 'restore'
          ? 'park_market_listings'
          : operation.action === 'revoke-restriction'
            ? 'park_market_restrictions'
            : 'park_market_appeals';
      const [object] = await tx.all(`SELECT park_id FROM ${table} WHERE id=?`, [
        operation.object,
      ]);
      if (!object) throw new MarketError('NOT_FOUND');
      await admin(tx, id, String(object.park_id));
    },
  );
  const execute = <T>(
    actor: string,
    action: string,
    object: string,
    input: Input,
    work: (tx: MarketTransaction) => Promise<T>,
    scope: string | null = null,
  ) =>
    unit.execute(
      actor,
      String(input.requestId ?? ''),
      { action, object, input, scope },
      work,
    );
  async function admin(tx: MarketTransaction, actor: string, park: string) {
    const principal = await deps.principal(tx, actor);
    requireActive(principal);
    if (!canModerate(principal, park)) throw new MarketError('FORBIDDEN');
  }
  async function audit(
    tx: MarketTransaction,
    park: string,
    actor: string,
    object: string,
    action: string,
    reason: string,
  ) {
    const id = randomUUID();
    await tx.run('INSERT INTO park_market_audit VALUES (?,?,?,?,?,?,?)', [
      id,
      park,
      actor,
      object,
      action,
      now(),
      encode({ reason }, `park-market-audit:${id}`),
    ]);
  }
  async function notify(
    tx: MarketTransaction,
    account: string,
    object: string,
    version: number,
    kind: string,
  ) {
    await tx.run(
      'INSERT INTO park_market_outbox(id,account_id,kind,object_id,object_version,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      [`${object}:${kind}:${version}`, account, kind, object, version, now()],
    );
  }
  async function load(tx: MarketTransaction, id: string): Promise<Listing> {
    const [row] = await tx.all(
      'SELECT payload FROM park_market_listings WHERE id=?',
      [id],
    );
    if (!row) throw new MarketError('NOT_FOUND');
    return decode(row.payload, `park-market-listing:${id}`);
  }
  async function save(
    tx: MarketTransaction,
    item: Listing,
    actor: string,
    action: string,
  ) {
    if (!['active', 'reserved'].includes(item.state))
      await endMarketListingRequests(tx, item.id);
    const payload = encode(item, `park-market-listing:${item.id}`);
    if (
      (await tx.run(
        'UPDATE park_market_listings SET state=?,version=?,updated_at=?,ended_at=?,payload=? WHERE id=? AND version=?',
        [
          item.state,
          item.version,
          item.updatedAt,
          item.endedAt,
          payload,
          item.id,
          item.version - 1,
        ],
      )) !== 1
    )
      throw new MarketError('CONFLICT');
    await tx.run('INSERT INTO park_market_history VALUES (?,?,?,?,?,?,?)', [
      randomUUID(),
      item.id,
      item.version,
      actor,
      action,
      now(),
      payload,
    ]);
  }
  async function restore(
    tx: MarketTransaction,
    actor: string,
    id: string,
    expectedVersion: unknown,
    reason: string,
  ) {
    const listing = await load(tx, id);
    await admin(tx, actor, listing.parkId);
    if (listing.state !== 'removed' || listing.version !== expectedVersion)
      throw new MarketError('CONFLICT');
    const next: Listing = {
      ...listing,
      state: 'offline',
      offlineAt: now(),
      offlineReason: 'moderation-restored',
      offlineVersion: null,
      reservation: null,
      version: listing.version + 1,
      updatedAt: now(),
    };
    await save(tx, next, actor, 'moderation-restore');
    await audit(tx, listing.parkId, actor, id, 'restore', reason);
    await notify(tx, listing.ownerId, id, next.version, 'moderation-restored');
    return next;
  }
  async function evidence(
    tx: MarketTransaction,
    actor: string,
    park: string,
    object: string,
    input: unknown,
  ) {
    const ids = input ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length > 3 ||
      ids.some((id) => typeof id !== 'string')
    )
      throw new MarketError('INVALID_INPUT', 'evidenceIds');
    const principal = await deps.principal(tx, actor);
    for (const id of new Set(ids)) {
      const [image] = await tx.all(
        'SELECT * FROM park_market_images WHERE id=?',
        [id],
      );
      if (
        !image ||
        image.owner_id !== actor ||
        image.park_id !== park ||
        image.state !== 'available' ||
        principal?.parkId !== park
      )
        throw new MarketError('NOT_FOUND');
      await tx.run(
        "INSERT INTO park_market_image_refs VALUES (?,'evidence',?,?,NULL)",
        [id, object, actor],
      );
    }
    return ids;
  }
  const readRecords = async (
    tx: MarketTransaction,
    table: 'reports' | 'appeals',
    where: string,
    args: unknown[],
  ) => {
    const rows = await tx.all(
      `SELECT * FROM park_market_${table} WHERE ${where} ORDER BY created_at DESC,id LIMIT 200`,
      args,
    );
    return rows.map((row) => ({
      ...row,
      payload: decode(
        row.payload,
        `park-market-${table === 'reports' ? 'report' : 'appeal'}:${row.id}`,
      ),
    }));
  };
  return {
    async records(actor: string, park: string) {
      return deps.repository.read(async (tx) => {
        await admin(tx, actor, park);
        return {
          reports: await readRecords(tx, 'reports', 'park_id=?', [park]),
          appeals: await readRecords(tx, 'appeals', 'park_id=?', [park]),
          restrictions: (
            await tx.all(
              'SELECT * FROM park_market_restrictions WHERE park_id=? ORDER BY created_at DESC LIMIT 200',
              [park],
            )
          ).map((row) => ({
            ...row,
            reason: decode(row.reason, `park-market-restriction:${row.id}`),
          })),
          audit: (
            await tx.all(
              'SELECT * FROM park_market_audit WHERE park_id=? ORDER BY created_at DESC,id LIMIT 200',
              [park],
            )
          ).map((row) => ({
            ...row,
            payload: decode(row.payload, `park-market-audit:${row.id}`),
          })),
        };
      });
    },
    async ownRecords(actor: string) {
      return deps.repository.read(async (tx) => {
        requireActive(await deps.principal(tx, actor));
        return {
          reports: await readRecords(tx, 'reports', 'reporter_id=?', [actor]),
          appeals: await readRecords(tx, 'appeals', 'owner_id=?', [actor]),
          restrictions: (
            await tx.all(
              'SELECT * FROM park_market_restrictions WHERE account_id=? ORDER BY created_at DESC LIMIT 200',
              [actor],
            )
          ).map((row) => ({
            ...row,
            reason: decode(row.reason, `park-market-restriction:${row.id}`),
          })),
          decisions: (
            await tx.all(
              'SELECT r.id,r.created_at,r.closed_at,r.payload FROM park_market_reports r JOIN park_market_listings l ON l.id=r.object_id WHERE l.owner_id=? AND r.closed_at IS NOT NULL ORDER BY r.created_at DESC LIMIT 200',
              [actor],
            )
          ).map((row) => ({
            id: row.id,
            at: row.closed_at,
            decisions: decode(row.payload, `park-market-report:${row.id}`)
              .decisions,
          })),
        };
      });
    },
    async restrict(actor: string, park: string, account: string, input: Input) {
      return execute(
        actor,
        'restrict',
        account,
        input,
        async (tx) => {
          await admin(tx, actor, park);
          const subject = await deps.principal(tx, account);
          if (!subject || subject.parkId !== park)
            throw new MarketError('NOT_FOUND');
          const reason = textField(input.reason, 'reason', 2, 500);
          const expiresAt = input.permanent === true ? null : input.expiresAt;
          if (
            expiresAt !== null &&
            (typeof expiresAt !== 'number' ||
              !Number.isSafeInteger(expiresAt) ||
              expiresAt <= now())
          )
            throw new MarketError('INVALID_INPUT', 'expiresAt');
          const id = randomUUID();
          await tx.run(
            'INSERT INTO park_market_restrictions VALUES (?,?,?,?,?,NULL,?,?)',
            [
              id,
              park,
              account,
              encode(reason, `park-market-restriction:${id}`),
              expiresAt,
              now(),
              actor,
            ],
          );
          const rows = await tx.all(
            "SELECT id FROM park_market_listings WHERE park_id=? AND owner_id=? AND state IN ('active','reserved')",
            [park, account],
          );
          for (const row of rows) {
            const next = transitionListing(
              await load(tx, String(row.id)),
              'restriction-offline',
              now(),
            );
            await save(tx, next, actor, 'restriction-offline');
          }
          await audit(tx, park, actor, id, 'restrict', reason);
          await notify(tx, account, id, 1, 'publication-restricted');
          return { id };
        },
        park,
      );
    },
    async revokeRestriction(actor: string, id: string, input: Input) {
      return execute(actor, 'revoke-restriction', id, input, async (tx) => {
        const [row] = await tx.all(
          'SELECT * FROM park_market_restrictions WHERE id=?',
          [id],
        );
        if (!row) throw new MarketError('NOT_FOUND');
        await admin(tx, actor, String(row.park_id));
        if (row.revoked_at !== null) throw new MarketError('CONFLICT');
        const reason = textField(input.reason, 'reason', 2, 500);
        await tx.run(
          'UPDATE park_market_restrictions SET revoked_at=? WHERE id=?',
          [now(), id],
        );
        await audit(
          tx,
          String(row.park_id),
          actor,
          id,
          'revoke-restriction',
          reason,
        );
        await notify(tx, String(row.account_id), id, 2, 'publication-restored');
        return { id };
      });
    },
    async restore(actor: string, id: string, input: Input) {
      return execute(actor, 'restore', id, input, (tx) =>
        restore(
          tx,
          actor,
          id,
          input.expectedVersion,
          textField(input.reason, 'reason', 2, 500),
        ),
      );
    },
    async appeal(actor: string, listingId: string, input: Input) {
      return execute(actor, 'appeal', listingId, input, async (tx) => {
        const listing = await load(tx, listingId);
        if (listing.ownerId !== actor) throw new MarketError('NOT_FOUND');
        if (listing.state !== 'removed') throw new MarketError('CONFLICT');
        const [pending] = await tx.all(
          'SELECT id,version FROM park_market_appeals WHERE owner_id=? AND listing_id=? AND closed_at IS NULL',
          [actor, listingId],
        );
        if (pending)
          return { id: String(pending.id), version: Number(pending.version) };
        const description = textField(
          input.description,
          'description',
          1,
          1000,
        );
        const id = randomUUID();
        const evidenceIds = await evidence(
          tx,
          actor,
          listing.parkId,
          id,
          input.evidenceIds,
        );
        await tx.run(
          'INSERT INTO park_market_appeals(id,park_id,owner_id,listing_id,state,version,created_at,payload) VALUES (?,?,?,?,?,?,?,?)',
          [
            id,
            listing.parkId,
            actor,
            listingId,
            'pending',
            1,
            now(),
            encode(
              { description, evidenceIds, decisions: [] },
              `park-market-appeal:${id}`,
            ),
          ],
        );
        await audit(tx, listing.parkId, actor, id, 'appeal', '提交申诉');
        await notify(tx, actor, id, 1, 'appeal-accepted');
        return { id, version: 1 };
      });
    },
    async resolveAppeal(actor: string, id: string, input: Input) {
      return execute(actor, 'resolve-appeal', id, input, async (tx) => {
        const [row] = await tx.all(
          'SELECT * FROM park_market_appeals WHERE id=?',
          [id],
        );
        if (!row) throw new MarketError('NOT_FOUND');
        await admin(tx, actor, String(row.park_id));
        if (
          row.closed_at !== null ||
          Number(row.version) !== input.expectedVersion
        )
          throw new MarketError('CONFLICT');
        if (!['restore', 'dismiss'].includes(String(input.decision)))
          throw new MarketError('INVALID_INPUT', 'decision');
        const reason = textField(input.reason, 'reason', 2, 500);
        if (input.decision === 'restore') {
          const listing = await load(tx, String(row.listing_id));
          await restore(tx, actor, listing.id, listing.version, reason);
        }
        const payload = decode(row.payload, `park-market-appeal:${id}`);
        payload.decisions.push({
          actorId: actor,
          decision: input.decision,
          reason,
          at: now(),
        });
        await tx.run(
          "UPDATE park_market_appeals SET state='closed',version=version+1,closed_at=?,payload=? WHERE id=?",
          [now(), encode(payload, `park-market-appeal:${id}`), id],
        );
        await tx.run(
          "UPDATE park_market_image_refs SET expires_at=? WHERE kind='evidence' AND object_id=?",
          [now() + 180 * 86400000, id],
        );
        await audit(
          tx,
          String(row.park_id),
          actor,
          id,
          'resolve-appeal',
          reason,
        );
        await notify(
          tx,
          String(row.owner_id),
          id,
          Number(row.version) + 1,
          'appeal-result',
        );
        return { id, version: Number(row.version) + 1 };
      });
    },
  };
}
