import { it, expect } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
import { createMarketContacts } from './fleaMarketContacts.js';
import { runMarketJobs } from './fleaMarketJobs.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: renewal committed ahead of queued expiry cleanup cannot be overwritten by the old deadline`, async () => {
    const h = await harness();
    const entered = barrier();
    const resume = barrier();
    try {
      const base = await marketServiceFixture(h.repository);
      const listing = await createMarketService(base).publish('seller', {
        ...testListingFields,
        requestId: 'race-publish',
      });
      let calls = 0;
      const deps = {
        ...base,
        now: () => listing.expiresAt - 1,
        principal: async (
          tx: Parameters<typeof base.principal>[0],
          id: string,
        ) => {
          if (++calls === 2) {
            entered.release();
            await resume.wait;
          }
          return base.principal(tx, id);
        },
      };
      const renewal = createMarketService(deps).command(
        'seller',
        listing.id,
        'confirm-active',
        { requestId: 'renew', expectedVersion: 1 },
      );
      await entered.wait;
      const cleanup = runMarketJobs({ ...base, now: () => listing.expiresAt });
      resume.release();
      await Promise.all([renewal, cleanup]);
      const [current] = await createMarketService(base).mine('seller');
      expect(current.state).toBe('active');
      expect(current.expiresAt).toBeGreaterThan(listing.expiresAt);
      expect(current.version).toBe(2);
    } finally {
      resume.release();
      await h.close();
    }
  }, 30000);
  it(`${backend}: identity revocation holding the transaction blocks and rejects a queued first contact without a message`, async () => {
    const h = await harness();
    const entered = barrier();
    const resume = barrier();
    try {
      const base = await marketServiceFixture(h.repository);
      const listing = await createMarketService(base).publish('seller', {
        ...testListingFields,
        requestId: 'race-publish',
      });
      const revoke = h.repository.transaction(async (tx) => {
        await tx.run(
          "UPDATE test_market_accounts SET active=0 WHERE id='buyer'",
        );
        entered.release();
        await resume.wait;
      });
      await entered.wait;
      const contacts = createMarketContacts({
        ...base,
        verifyMessage: async () => ({ ciphertext: 'unused fixture' }),
      });
      const contact = contacts.contact('buyer', listing.id, {
        requestId: 'race-contact',
        expectedVersion: 1,
        envelope: { ciphertext: 'unused fixture' },
      });
      const checked = expect(contact).rejects.toThrow();
      resume.release();
      await Promise.all([revoke, checked]);
      expect(
        await h.repository.read((tx) =>
          tx.all('SELECT id FROM park_contact_messages'),
        ),
      ).toEqual([]);
      expect(
        await h.repository.read((tx) =>
          tx.all('SELECT id FROM park_market_contact_requests'),
        ),
      ).toEqual([]);
    } finally {
      resume.release();
      await h.close();
    }
  }, 30000);
}

for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: committed draft renewal and publication protect the image from queued cleanup`, async () => {
    const h = await harness();
    const entered = barrier();
    const resume = barrier();
    try {
      const base = await marketServiceFixture(h.repository);
      await h.repository.transaction(async (tx) => {
        await tx.run('UPDATE park_market_image_refs SET expires_at=0');
        await tx.run('UPDATE park_market_images SET orphaned_at=0');
      });
      let pause = true;
      const { createMarketAttachments } =
        await import('./fleaMarketAttachments.js');
      const objects = {
        put: () => ({ key: 'unused' }),
        read: () => Buffer.from('synthetic'),
        delete: () => {
          throw new Error('referenced object must not be deleted');
        },
      };
      const images = createMarketAttachments({
        ...base,
        objects,
        listingReadable: async () => true,
        principal: async (tx, id) => {
          if (pause) {
            pause = false;
            entered.release();
            await resume.wait;
          }
          return base.principal(tx, id);
        },
      });
      const lease = images.lease('seller', 'fixture', ['image-1']);
      await entered.wait;
      const cleanup = images.cleanup();
      resume.release();
      await Promise.all([lease, cleanup]);
      expect((await images.read('seller', 'image-1')).content.toString()).toBe(
        'synthetic',
      );
      const publication = await createMarketService(base).publish('seller', {
        ...testListingFields,
        requestId: 'bind',
      });
      await Promise.all([images.cleanup(), images.cleanup()]);
      expect(
        await h.repository.read((tx) =>
          tx.all(
            "SELECT object_id FROM park_market_image_refs WHERE kind='listing'",
          ),
        ),
      ).toEqual([{ object_id: publication.id }]);
    } finally {
      resume.release();
      await h.close();
    }
  }, 30000);
  it(`${backend}: report snapshot holding the write transaction survives a queued seller deletion`, async () => {
    const h = await harness();
    const entered = barrier();
    const resume = barrier();
    try {
      const base = await marketServiceFixture(h.repository);
      const service = createMarketService(base);
      const listing = await service.publish('seller', {
        ...testListingFields,
        requestId: 'publish',
      });
      const { createMarketModeration } =
        await import('./fleaMarketModeration.js');
      let pause = true;
      const moderation = createMarketModeration({
        ...base,
        principal: async (tx, id) => {
          if (pause) {
            pause = false;
            entered.release();
            await resume.wait;
          }
          return base.principal(tx, id);
        },
      });
      const reporting = moderation.report('buyer', listing.id, {
        requestId: 'report',
        reason: 'misleading',
      });
      await entered.wait;
      const deleting = (async () => {
        await service.command('seller', listing.id, 'offline', {
          requestId: 'offline',
          expectedVersion: 1,
        });
        await service.command('seller', listing.id, 'delete', {
          requestId: 'delete',
          expectedVersion: 2,
        });
      })();
      resume.release();
      const [report] = await Promise.all([reporting, deleting]);
      const [row] = await h.repository.read((tx) =>
        tx.all('SELECT payload FROM park_market_reports WHERE id=?', [
          report.id,
        ]),
      );
      const frozen = JSON.parse(
        base.cipher.decryptText(
          JSON.parse(String(row.payload)),
          `park-market-report:${report.id}`,
        ),
      );
      expect(frozen.snapshot.state).toBe('active');
      expect(frozen.snapshot.description).toBe(testListingFields.description);
      expect(
        await h.repository.read((tx) =>
          tx.all(
            "SELECT image_id FROM park_market_image_refs WHERE kind='evidence' AND object_id=?",
            [report.id],
          ),
        ),
      ).toEqual([{ image_id: 'image-1' }]);
    } finally {
      resume.release();
      await h.close();
    }
  }, 30000);
}
