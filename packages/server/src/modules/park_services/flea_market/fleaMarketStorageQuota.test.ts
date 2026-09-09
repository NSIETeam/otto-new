/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { createMarketPostgresImageQuota } from './fleaMarketStorageQuota.js';
import {
  postgresMarketHarness,
  marketServiceFixture,
} from './fleaMarketTestSupport.js';
it('charges market images against the same tenant quota as ordinary attachments and releases exactly once', async () => {
  const h = await postgresMarketHarness();
  try {
    const base = await marketServiceFixture(h.repository);
    const actor = await h.repository.read((tx) => base.principal(tx, 'seller'));
    await h.repository.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO organizations(id,name,slug) VALUES ('E1','test','test')",
      );
      await tx.run(
        "INSERT INTO attachment_storage_quotas(organization_id,max_bytes,stored_bytes,reserved_bytes) VALUES ('E1',1000,700,100)",
      );
    });
    const quota = createMarketPostgresImageQuota(1000);
    await expect(
      h.repository.transaction((tx) => quota.charge(tx, actor!, 'image1', 201)),
    ).rejects.toThrow('LIMIT_REACHED');
    await h.repository.transaction((tx) =>
      quota.charge(tx, actor!, 'image1', 200),
    );
    const [charged] = await h.repository.read((tx) =>
      tx.all(
        "SELECT stored_bytes FROM attachment_storage_quotas WHERE organization_id='E1'",
      ),
    );
    expect(Number(charged.stored_bytes)).toBe(900);
    await h.repository.transaction((tx) => quota.release(tx, 'image1'));
    await h.repository.transaction((tx) => quota.release(tx, 'image1'));
    const [released] = await h.repository.read((tx) =>
      tx.all(
        "SELECT stored_bytes FROM attachment_storage_quotas WHERE organization_id='E1'",
      ),
    );
    expect(Number(released.stored_bytes)).toBe(700);
  } finally {
    await h.close();
  }
}, 30000);
