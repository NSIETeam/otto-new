/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { MarketServiceDependencies } from './fleaMarketService.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
import { MarketError, type MarketConfig } from './fleaMarketTypes.js';
import { canModerate, requireActive, samePark } from './fleaMarketAccess.js';
import { textField } from './fleaMarketValidation.js';
import { createMarketUnitOfWork } from './fleaMarketUnitOfWork.js';
export function createMarketSettings(
  deps: Omit<MarketServiceDependencies, 'config'>,
  isReady: () => boolean,
) {
  const now = deps.now ?? Date.now;
  const unit = createMarketUnitOfWork(
    deps.repository,
    deps.cipher,
    async (tx, actorId, payload) => {
      const actor = await deps.principal(tx, actorId);
      requireActive(actor);
      if (!canModerate(actor, (payload as { park: string }).park))
        throw new MarketError('FORBIDDEN');
    },
  );
  async function config(
    tx: MarketTransaction,
    park: string,
  ): Promise<MarketConfig & { version: number }> {
    const [row] = await tx.all(
      'SELECT * FROM park_market_config WHERE park_id=?',
      [park],
    );
    const stored = row
      ? JSON.parse(
          deps.cipher.decryptText(
            JSON.parse(String(row.payload)),
            `park-market-config:${park}`,
          ),
        )
      : {
          enabled: true,
          timezone: 'Asia/Shanghai',
          rules: '',
          responsibleAccountId: '',
          contact: '',
        };
    return { ...stored, ready: isReady(), version: Number(row?.version ?? 0) };
  }
  return {
    config,
    async read(account: string) {
      return deps.repository.read(async (tx) => {
        const actor = await deps.principal(tx, account);
        requireActive(actor);
        if (!actor.parkId || !samePark(actor, actor.parkId))
          return {
            parkId: null,
            enabled: false,
            ready: isReady(),
            version: 0,
            rules: '',
            contact: '',
            responsibleAccountId: '',
            timezone: 'Asia/Shanghai',
            canModerate: false,
          };
        return {
          ...(await config(tx, actor.parkId)),
          parkId: actor.parkId,
          canModerate: canModerate(actor, actor.parkId),
        };
      });
    },
    async update(
      account: string,
      park: string,
      input: Record<string, unknown>,
    ) {
      return unit.execute(
        account,
        String(input.requestId ?? ''),
        { action: 'configure', park, input },
        async (tx) => {
          const actor = await deps.principal(tx, account);
          if (!canModerate(actor, park)) throw new MarketError('FORBIDDEN');
          const current = await config(tx, park);
          if (input.expectedVersion !== current.version)
            throw new MarketError('CONFLICT', 'expectedVersion');
          if (typeof input.enabled !== 'boolean')
            throw new MarketError('INVALID_INPUT', 'enabled');
          const rules = textField(input.rules, 'rules', 5, 10000);
          const contact = textField(input.contact, 'contact', 2, 200);
          const responsibleAccountId = textField(
            input.responsibleAccountId,
            'responsibleAccountId',
            1,
            128,
          );
          if (!samePark(await deps.principal(tx, responsibleAccountId), park))
            throw new MarketError('INVALID_INPUT', 'responsibleAccountId');
          const timezone = textField(
            input.timezone ?? 'Asia/Shanghai',
            'timezone',
            1,
            100,
          );
          try {
            new Intl.DateTimeFormat('en', { timeZone: timezone }).format(now());
          } catch {
            throw new MarketError('INVALID_INPUT', 'timezone');
          }
          if (input.enabled && !isReady())
            throw new MarketError('DEPENDENCY_UNAVAILABLE');
          const value = {
            enabled: input.enabled,
            rules,
            contact,
            responsibleAccountId,
            timezone,
          };
          const payload = JSON.stringify(
            deps.cipher.encryptText(
              JSON.stringify(value),
              `park-market-config:${park}`,
            ),
          );
          await tx.run(
            'INSERT INTO park_market_config VALUES (?,?,?) ON CONFLICT(park_id) DO UPDATE SET version=excluded.version,payload=excluded.payload',
            [park, current.version + 1, payload],
          );
          const auditId = randomUUID();
          await tx.run('INSERT INTO park_market_audit VALUES (?,?,?,?,?,?,?)', [
            auditId,
            park,
            account,
            park,
            'configure',
            now(),
            JSON.stringify(
              deps.cipher.encryptText(
                JSON.stringify({
                  version: current.version + 1,
                  enabled: value.enabled,
                }),
                `park-market-audit:${auditId}`,
              ),
            ),
          ]);
          return { ...value, ready: isReady(), version: current.version + 1 };
        },
      );
    },
  };
}
