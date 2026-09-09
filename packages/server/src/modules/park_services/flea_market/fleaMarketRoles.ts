import { randomUUID } from 'node:crypto';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { MarketServiceDependencies } from './fleaMarketService.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
import { requireActive, samePark } from './fleaMarketAccess.js';
import { MarketError } from './fleaMarketTypes.js';
import { createMarketUnitOfWork } from './fleaMarketUnitOfWork.js';
export const MARKET_ROLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS park_market_admins (
 park_id TEXT NOT NULL, account_id TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at BIGINT NOT NULL,
 PRIMARY KEY(park_id,account_id)
);`;
export function createMarketRoles(
  deps: Omit<MarketServiceDependencies, 'config'> & {
    canAssign(
      tx: MarketTransaction,
      account: string,
      park: string,
    ): Promise<boolean>;
  },
) {
  const unit = createMarketUnitOfWork(
    deps.repository,
    deps.cipher,
    async (tx, actor, payload) => {
      requireActive(await deps.principal(tx, actor));
      if (
        !(await deps.canAssign(tx, actor, (payload as { park: string }).park))
      )
        throw new MarketError('FORBIDDEN');
    },
  );
  return {
    async list(actor: string, park: string) {
      return deps.repository.read(async (tx) => {
        requireActive(await deps.principal(tx, actor));
        if (!(await deps.canAssign(tx, actor, park)))
          throw new MarketError('FORBIDDEN');
        return tx.all(
          'SELECT account_id,granted_by,granted_at FROM park_market_admins WHERE park_id=? ORDER BY account_id',
          [park],
        );
      });
    },
    async assign(actor: string, park: string, input: Record<string, unknown>) {
      return unit.execute(
        actor,
        String(input.requestId ?? ''),
        { action: 'market-role', park, input },
        async (tx) => {
          if (!(await deps.canAssign(tx, actor, park)))
            throw new MarketError('FORBIDDEN');
          if (
            typeof input.accountId !== 'string' ||
            typeof input.enabled !== 'boolean'
          )
            throw new MarketError('INVALID_INPUT');
          if (
            input.enabled &&
            !samePark(await deps.principal(tx, input.accountId), park)
          )
            throw new MarketError('NOT_FOUND');
          if (input.enabled)
            await tx.run(
              'INSERT INTO park_market_admins VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
              [park, input.accountId, actor, (deps.now ?? Date.now)()],
            );
          else
            await tx.run(
              'DELETE FROM park_market_admins WHERE park_id=? AND account_id=?',
              [park, input.accountId],
            );
          const auditId = randomUUID();
          await tx.run('INSERT INTO park_market_audit VALUES (?,?,?,?,?,?,?)', [
            auditId,
            park,
            actor,
            input.accountId,
            input.enabled ? 'grant-market-admin' : 'revoke-market-admin',
            (deps.now ?? Date.now)(),
            JSON.stringify(
              deps.cipher.encryptText(
                JSON.stringify({
                  accountId: input.accountId,
                  enabled: input.enabled,
                }),
                `park-market-audit:${auditId}`,
              ),
            ),
          ]);
          return { accountId: input.accountId, enabled: input.enabled };
        },
      );
    },
  };
}
