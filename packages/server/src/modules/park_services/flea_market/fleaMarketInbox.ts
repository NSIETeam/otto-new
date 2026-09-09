/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { MarketServiceDependencies } from './fleaMarketService.js';
import { requireActive } from './fleaMarketAccess.js';
import { MarketError, type MarketNotification } from './fleaMarketTypes.js';
export function createMarketInbox(deps: MarketServiceDependencies) {
  return {
    async list(accountId: string, before?: number, cursor?: string) {
      let page: { at: number; id: string } | undefined;
      if (cursor !== undefined) {
        try {
          if (cursor.length > 1000) throw new Error();
          page = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          if (
            !page ||
            !Number.isSafeInteger(page.at) ||
            page.at < 0 ||
            typeof page.id !== 'string' ||
            page.id.length > 300
          )
            throw new Error();
        } catch {
          throw new MarketError('INVALID_INPUT', 'cursor');
        }
      }
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 0))
        throw new MarketError('INVALID_INPUT', 'before');
      return deps.repository.read(async (tx) => {
        requireActive(await deps.principal(tx, accountId));
        const rows = await tx.all(
          `SELECT * FROM park_market_notifications WHERE account_id=? AND created_at<=? ${page ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 101`,
          [
            accountId,
            before ?? Number.MAX_SAFE_INTEGER,
            ...(page ? [page.at, page.at, page.id] : []),
          ],
        );
        const [{ count }] = await tx.all(
          'SELECT COUNT(*) AS count FROM park_market_notifications WHERE account_id=? AND read_at IS NULL',
          [accountId],
        );
        const items: MarketNotification[] = rows.slice(0, 100).map((row) => ({
          id: String(row.id),
          accountId,
          kind: String(row.kind),
          objectId: String(row.object_id),
          objectVersion: Number(row.object_version),
          createdAt: Number(row.created_at),
          readAt: row.read_at === null ? null : Number(row.read_at),
        }));
        return {
          items,
          unread: Number(count),
          nextCursor:
            rows.length > 100
              ? Buffer.from(
                  JSON.stringify({
                    at: items.at(-1)!.createdAt,
                    id: items.at(-1)!.id,
                  }),
                ).toString('base64url')
              : null,
        };
      });
    },
    async markRead(accountId: string, ids: unknown) {
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        ids.some((id) => typeof id !== 'string' || id.length > 300)
      )
        throw new MarketError('INVALID_INPUT', 'ids');
      await deps.repository.transaction(async (tx) => {
        requireActive(await deps.principal(tx, accountId));
        for (const id of new Set(ids))
          await tx.run(
            'UPDATE park_market_notifications SET read_at=? WHERE id=? AND account_id=? AND read_at IS NULL',
            [(deps.now ?? Date.now)(), id, accountId],
          );
      });
      return { success: true };
    },
  };
}
