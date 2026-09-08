import { indexMarketListing } from './fleaMarketSearchIndex.js';
import { endMarketListingRequests } from './fleaMarketContacts.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { MarketServiceDependencies } from './fleaMarketService.js';
import type { Listing } from './fleaMarketTypes.js';
import { samePark } from './fleaMarketAccess.js';
import { MARKET_DAY, transitionListing } from './fleaMarketLifecycle.js';
function clearContent(listing: Listing, time: number): Listing {
  return {
    ...listing,
    imageIds: [],
    description: '',
    faultDescription: '',
    handoverArea: '',
    handoverTime: '',
    reservation: null,
    cleanedAt: time,
  };
}
// Each bounded batch owns the database write lock; other commands can run between batches.
// Outbox keys and current listing versions make concurrent workers and restarts idempotent.
export async function runMarketJobs(
  deps: MarketServiceDependencies,
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  await deps.repository.transaction(async (tx) => {
    const [progress] = await tx.all(
      "SELECT cursor FROM park_market_maintenance WHERE name='listings'",
    );
    const cursor = String(progress?.cursor ?? '');
    const due = await tx.all(
      "SELECT * FROM park_market_listings WHERE state IN ('active','reserved') AND expires_at<=? ORDER BY expires_at,id LIMIT 100",
      [now],
    );
    const scanned = await tx.all(
      'SELECT * FROM park_market_listings WHERE id>? ORDER BY id LIMIT 150',
      [cursor],
    );
    const rows = [
      ...new Map([...due, ...scanned].map((row) => [row.id, row])).values(),
    ];
    const owners = new Map<
      string,
      Awaited<ReturnType<typeof deps.principal>>
    >();
    for (const row of rows) {
      const context = `park-market-listing:${row.id}`;
      const listing: Listing = JSON.parse(
        deps.cipher.decryptText(JSON.parse(String(row.payload)), context),
      );
      if (!owners.has(listing.ownerId))
        owners.set(listing.ownerId, await deps.principal(tx, listing.ownerId));
      const owner = owners.get(listing.ownerId) ?? null;
      const live = ['active', 'reserved'].includes(listing.state);
      let next = listing;
      let action = '';
      const emit = async (kind: string, key: string) => {
        if (owner?.active)
          await tx.run(
            'INSERT INTO park_market_outbox(id,account_id,kind,object_id,object_version,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
            [
              `${listing.id}:${kind}:${key}`,
              listing.ownerId,
              kind,
              listing.id,
              listing.version,
              now,
            ],
          );
      };
      if (
        live &&
        (!samePark(owner, listing.parkId) || listing.expiresAt <= now)
      ) {
        action = listing.expiresAt <= now ? 'expire' : 'identity-offline';
        next = transitionListing(listing, action, now);
        await emit('automatic-offline', String(next.version));
      } else if (live) {
        if (listing.expiresAt - now <= 3 * MARKET_DAY)
          await emit('expiry-reminder', String(listing.expiresAt));
        if (listing.reservation && listing.reservation.remindAt <= now)
          await emit(
            'reservation-reminder',
            `${listing.reservation.cycle}:${listing.reservation.reminderVersion}`,
          );
      }
      if (!live && listing.endedAt !== null && listing.cleanedAt === null) {
        const deadline = listing.endedAt + 180 * MARKET_DAY;
        if (now >= deadline) {
          action = 'content-cleanup';
          next = {
            ...clearContent(listing, now),
            version: listing.version + 1,
            updatedAt: now,
          };
          await tx.run(
            "DELETE FROM park_market_image_refs WHERE kind='listing' AND object_id=?",
            [listing.id],
          );
          // Historical versions and retry receipts are copies too; scrub them rather than
          // leaving a hidden permanent copy of the removed description and private note.
          for (const history of await tx.all(
            'SELECT * FROM park_market_history WHERE listing_id=?',
            [listing.id],
          )) {
            const old = JSON.parse(
              deps.cipher.decryptText(
                JSON.parse(String(history.payload)),
                context,
              ),
            );
            await tx.run(
              'UPDATE park_market_history SET payload=? WHERE id=?',
              [
                JSON.stringify(
                  deps.cipher.encryptText(
                    JSON.stringify(clearContent(old, now)),
                    context,
                  ),
                ),
                history.id,
              ],
            );
          }
          for (const operation of await tx.all(
            'SELECT * FROM park_market_operations WHERE actor_id=?',
            [listing.ownerId],
          )) {
            const receiptContext = `park-market-operation:${operation.actor_id}:${operation.request_id}`;
            const result = JSON.parse(
              deps.cipher.decryptText(
                JSON.parse(String(operation.result)),
                receiptContext,
              ),
            );
            if (result?.id === listing.id)
              await tx.run(
                'UPDATE park_market_operations SET result=? WHERE actor_id=? AND request_id=?',
                [
                  JSON.stringify(
                    deps.cipher.encryptText(
                      JSON.stringify(clearContent(result, now)),
                      receiptContext,
                    ),
                  ),
                  operation.actor_id,
                  operation.request_id,
                ],
              );
          }
        } else if (now >= deadline - 7 * MARKET_DAY)
          await emit('cleanup-reminder', String(deadline));
      }
      if (action) {
        await indexMarketListing(tx, deps.cipher, next);
        if (!['active', 'reserved'].includes(next.state))
          await endMarketListingRequests(tx, next.id);
        const payload = JSON.stringify(
          deps.cipher.encryptText(JSON.stringify(next), context),
        );
        await tx.run(
          'UPDATE park_market_listings SET version=?,state=?,updated_at=?,ended_at=?,payload=? WHERE id=? AND version=?',
          [
            next.version,
            next.state,
            now,
            next.endedAt,
            payload,
            next.id,
            listing.version,
          ],
        );
        await tx.run('INSERT INTO park_market_history VALUES (?,?,?,?,?,?,?)', [
          randomUUID(),
          next.id,
          next.version,
          'system',
          action,
          now,
          payload,
        ]);
      }
    }
    await tx.run(
      "INSERT INTO park_market_maintenance(name,cursor,updated_at) VALUES ('listings',?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
      [scanned.length < 150 ? '' : String(scanned.at(-1)?.id), now],
    );
  });
  await deps.repository.transaction(async (tx) => {
    const scanClosed = async (
      table: 'park_market_reports' | 'park_market_appeals',
    ) => {
      const [progress] = await tx.all(
        'SELECT cursor FROM park_market_maintenance WHERE name=?',
        [table],
      );
      const rows = await tx.all(
        `SELECT * FROM ${table} WHERE closed_at IS NOT NULL AND closed_at<=? AND id>? ORDER BY id LIMIT 100`,
        [now - 180 * MARKET_DAY, progress?.cursor ?? ''],
      );
      await tx.run(
        'INSERT INTO park_market_maintenance(name,cursor,updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at',
        [table, rows.length < 100 ? '' : String(rows.at(-1)?.id), now],
      );
      return rows;
    };
    const oldReports = await scanClosed('park_market_reports');
    for (const report of oldReports) {
      const context = `park-market-report:${report.id}`;
      const payload = JSON.parse(
        deps.cipher.decryptText(JSON.parse(String(report.payload)), context),
      );
      if (payload.cleanedAt) continue;
      const minimal = {
        reason: payload.reason,
        decisions: payload.decisions,
        cleanedAt: now,
        evidenceIds: [],
        description: '',
        snapshot: {
          id: payload.snapshot.id,
          title: payload.snapshot.title,
          saleMode: payload.snapshot.saleMode,
          state: payload.snapshot.state,
        },
      };
      await tx.run('UPDATE park_market_reports SET payload=? WHERE id=?', [
        JSON.stringify(
          deps.cipher.encryptText(JSON.stringify(minimal), context),
        ),
        report.id,
      ]);
      await tx.run(
        "DELETE FROM park_market_image_refs WHERE kind='evidence' AND object_id=?",
        [report.id],
      );
    }
    for (const appeal of await scanClosed('park_market_appeals')) {
      const context = `park-market-appeal:${appeal.id}`;
      const payload = JSON.parse(
        deps.cipher.decryptText(JSON.parse(String(appeal.payload)), context),
      );
      if (payload.cleanedAt) continue;
      await tx.run('UPDATE park_market_appeals SET payload=? WHERE id=?', [
        JSON.stringify(
          deps.cipher.encryptText(
            JSON.stringify({
              description: '',
              evidenceIds: [],
              decisions: payload.decisions,
              cleanedAt: now,
            }),
            context,
          ),
        ),
        appeal.id,
      ]);
      await tx.run(
        "DELETE FROM park_market_image_refs WHERE kind='evidence' AND object_id=?",
        [appeal.id],
      );
      for (const audit of await tx.all(
        "SELECT id FROM park_market_audit WHERE object_id=? AND action='appeal'",
        [appeal.id],
      )) {
        await tx.run('UPDATE park_market_audit SET payload=? WHERE id=?', [
          JSON.stringify(
            deps.cipher.encryptText(
              JSON.stringify({ reason: '提交申诉', cleanedAt: now }),
              `park-market-audit:${audit.id}`,
            ),
          ),
          audit.id,
        ]);
      }
    }
    // A separate transport failure can retry from the same durable outbox. For in-app
    // notifications the consumer and receipt share the database transaction.
    const events = await tx.all(
      'SELECT * FROM park_market_outbox WHERE delivered_at IS NULL ORDER BY created_at,id LIMIT 250',
    );
    for (const event of events) {
      const [receipt] = String(event.id).startsWith('contact:')
        ? await tx.all(
            'SELECT read_at FROM park_contact_read_receipts WHERE account_id=? AND message_id=?',
            [event.account_id, String(event.id).slice(8)],
          )
        : [];
      await tx.run(
        'INSERT INTO park_market_notifications(id,account_id,kind,object_id,object_version,created_at,read_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        [
          event.id,
          event.account_id,
          event.kind,
          event.object_id,
          event.object_version,
          event.created_at,
          receipt?.read_at ?? null,
        ],
      );
      await tx.run('UPDATE park_market_outbox SET delivered_at=? WHERE id=?', [
        now,
        event.id,
      ]);
    }
  });
}

export const MARKET_MAINTENANCE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS park_market_maintenance(name TEXT PRIMARY KEY,cursor TEXT NOT NULL,updated_at BIGINT NOT NULL);`;
export const MARKET_CLEANUP_SCAN_SCHEMA_SQL = `CREATE INDEX IF NOT EXISTS park_market_image_cleanup_scan ON park_market_images(state,id);
CREATE INDEX IF NOT EXISTS park_market_outbox_delivery ON park_market_outbox(delivered_at,created_at,id);`;
