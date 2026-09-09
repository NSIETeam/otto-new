import { it, expect } from 'vitest';
import { postgresMarketHarness } from './fleaMarketTestSupport.js';
import { marketRemoteKeyReferenced } from './fleaMarketObjectStore.js';
it('shared orphan collection retains staged and bound market chat objects independently of product images', async () => {
  const h = await postgresMarketHarness();
  try {
    await h.repository.transaction((tx) =>
      tx.run(
        'INSERT INTO park_contact_attachments VALUES (?,?,?,?,?,?,?,?,NULL)',
        [
          'file',
          'chat',
          'buyer',
          'message',
          JSON.stringify({ key: 'private/chat', context: 'test' }),
          40,
          'hash',
          0,
        ],
      ),
    );
    const referenced = (key: string) =>
      h.repository.read((tx) =>
        marketRemoteKeyReferenced(
          { query: async (sql, args) => ({ rows: await tx.all(sql, args) }) },
          key,
        ),
      );
    expect(await referenced('private/chat')).toBe(true);
    expect(await referenced('private/missing')).toBe(false);
    await h.repository.transaction((tx) =>
      tx.run("UPDATE park_contact_attachments SET bound_at=1 WHERE id='file'"),
    );
    expect(await referenced('private/chat')).toBe(true);
    await h.restart();
    expect(await referenced('private/chat')).toBe(true);
  } finally {
    await h.close();
  }
}, 30000);
