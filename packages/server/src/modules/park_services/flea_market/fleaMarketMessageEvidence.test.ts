/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { createMarketContacts } from './fleaMarketContacts.js';
import { createMarketService } from './fleaMarketService.js';
import { createMarketModeration } from './fleaMarketModeration.js';
import { createMarketGovernance } from './fleaMarketGovernance.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
for (const [name, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const)
  it(`${name}: message reports expose only selected authorized evidence, including ended listings`, async () => {
    const h = await harness();
    try {
      const base = await marketServiceFixture(h.repository);
      const deps = {
        ...base,
        principal: async (
          tx: Parameters<typeof base.principal>[0],
          id: string,
        ) => {
          const p = await base.principal(tx, id);
          return (
            p && { ...p, marketAdminParkIds: id === 'stranger' ? ['P'] : [] }
          );
        },
      };
      const market = createMarketService(deps);
      const contacts = createMarketContacts({
        ...deps,
        verifyMessage: async () => ({ ciphertext: 'opaque fixture' }),
      });
      const moderation = createMarketModeration(deps);
      const listing = await market.publish('seller', {
        ...testListingFields,
        requestId: 'publish',
      });
      const contact = await contacts.contact('buyer', listing.id, {
        requestId: 'question',
        expectedVersion: 1,
      });
      await contacts.resolve('seller', contact.requestId!, {
        requestId: 'accept',
        action: 'accept',
      });
      await contacts.send('seller', contact.conversationId, {
        requestId: 'reply',
      });
      await contacts.send('seller', contact.conversationId, {
        requestId: 'unselected',
      });
      await market.command('seller', listing.id, 'offline', {
        requestId: 'offline',
        expectedVersion: 1,
      });
      const evidence = {
        requestId: 'report',
        reason: 'harassment',
        selectedMessages: [{ id: 'reply', text: '用户主动选择并提交的原文' }],
      };
      await expect(
        moderation.report('stranger', listing.id, evidence),
      ).rejects.toThrow('NOT_FOUND');
      await moderation.report('buyer', listing.id, evidence);
      const reports = await createMarketGovernance(deps).records(
        'stranger',
        'P',
      );
      expect(reports.reports[0].payload.selectedMessages).toHaveLength(1);
      expect(reports.reports[0].payload.selectedMessages[0]).toMatchObject({
        id: 'reply',
        text: evidence.selectedMessages[0].text,
        senderId: 'seller',
        textSource: 'reporter-provided',
      });
      expect(
        JSON.stringify(reports.reports[0].payload.selectedMessages),
      ).not.toContain('unselected');
    } finally {
      await h.close();
    }
  }, 30000);
