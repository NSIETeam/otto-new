/** Database scheduling benchmark; crypto correctness is covered by encrypted-flow.test.ts. */
import { it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { createMarketContacts } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketContacts.js';
import { runMarketJobs } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketJobs.js';
import {
  postgresMarketHarness,
  sqliteMarketHarness,
  marketServiceFixture,
} from '../../packages/server/src/modules/park_services/flea_market/fleaMarketTestSupport.js';
for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: 100 independent active conversations retain writes and reads while two maintenance workers run`, async () => {
    const h = await harness();
    try {
      const base = await marketServiceFixture(h.repository);
      await h.repository.transaction(async (tx) => {
        for (let i = 0; i < 100; i++) {
          await tx.run('INSERT INTO test_market_accounts VALUES (?,?,?,1)', [
            `a-${i}`,
            'E1',
            'P',
          ]);
          await tx.run('INSERT INTO test_market_accounts VALUES (?,?,?,1)', [
            `b-${i}`,
            'E2',
            'P',
          ]);
          await tx.run(
            "INSERT INTO park_market_conversations VALUES (?,?,?,?, 'active',?)",
            [`c-${i}`, 'P', `a-${i}`, `b-${i}`, base.now()],
          );
        }
      });
      const contacts = createMarketContacts({
        ...base,
        verifyMessage: async (_tx, context, envelope) => ({
          context,
          envelope,
        }),
      });
      const writes: number[] = [],
        reads: number[] = [];
      await Promise.all([
        runMarketJobs(base),
        runMarketJobs(base),
        ...Array.from({ length: 100 }, async (_, i) => {
          const start = performance.now();
          const command = {
            requestId: `message-${i}`,
            envelope: {
              ciphertext: 'injected transport for database scheduling only',
            },
          };
          const sent = await contacts.send(`a-${i}`, `c-${i}`, command);
          writes.push(performance.now() - start);
          const readStart = performance.now();
          const page = await contacts.messages(`b-${i}`, `c-${i}`);
          reads.push(performance.now() - readStart);
          expect(page.items).toHaveLength(1);
          expect(await contacts.send(`a-${i}`, `c-${i}`, command)).toEqual(
            sent,
          );
        }),
      ]);
      writes.sort((a, b) => a - b);
      reads.sort((a, b) => a - b);
      const metrics = {
        backend,
        conversations: 100,
        concurrentWrites: 100,
        concurrentReads: 100,
        maintenanceWorkers: 2,
        writeP95Ms: writes[94],
        readP95Ms: reads[94],
        scope:
          'Real database business operations with injected transport; no network or encryption throughput claim',
      };
      writeFileSync(
        `docs/research/flea-market-evidence/repair-pass-2-conversation-capacity-${backend}-${Date.now()}.json`,
        JSON.stringify(metrics, null, 2),
      );
      expect(metrics.readP95Ms).toBeLessThanOrEqual(1000);
      expect(metrics.writeP95Ms).toBeLessThanOrEqual(1000);
      await h.restart();
      expect(
        await h.repository.read((tx) =>
          tx.all('SELECT COUNT(*) AS count FROM park_contact_messages'),
        ),
      ).toEqual([{ count: backend === 'postgres' ? '100' : 100 }]);
    } finally {
      await h.close();
    }
  }, 60000);
}
