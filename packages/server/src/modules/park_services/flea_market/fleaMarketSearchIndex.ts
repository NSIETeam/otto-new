/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHmac, randomBytes } from 'node:crypto';
import type { EncryptedFieldCipher } from '../../data_platform/index.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
import type { Listing } from './fleaMarketTypes.js';
export const MARKET_SEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS park_market_search_keys (park_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS park_market_search_documents (listing_id TEXT PRIMARY KEY,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS park_market_search_terms (park_id TEXT NOT NULL,token TEXT NOT NULL,listing_id TEXT NOT NULL,PRIMARY KEY(park_id,token,listing_id));
CREATE INDEX IF NOT EXISTS park_market_search_term_listing ON park_market_search_terms(listing_id);
`;
export async function marketSearchKey(
  tx: MarketTransaction,
  cipher: EncryptedFieldCipher,
  park: string,
  create = false,
): Promise<Buffer | null> {
  const context = `park-market-search-key:${park}`;
  const [row] = await tx.all(
    'SELECT payload FROM park_market_search_keys WHERE park_id=?',
    [park],
  );
  if (row)
    return Buffer.from(
      cipher.decryptText(JSON.parse(String(row.payload)), context),
      'base64',
    );
  if (!create) return null;
  const key = randomBytes(32);
  await tx.run('INSERT INTO park_market_search_keys VALUES (?,?)', [
    park,
    JSON.stringify(cipher.encryptText(key.toString('base64'), context)),
  ]);
  return key;
}
function token(key: Buffer, text: string) {
  return createHmac('sha256', key)
    .update('otto:market-search:v1\0')
    .update(text)
    .digest('hex');
}
function grams(text: string): string[] {
  const chars = Array.from(text.toLocaleLowerCase());
  return [
    ...new Set([...chars, ...chars.slice(1).map((c, i) => chars[i] + c)]),
  ];
}
// Deterministic tokens disclose equality/frequency, never literal title/description.
// They only select candidates; fresh account/park/state checks and exact text matching remain authoritative.
export function marketQueryTokens(key: Buffer, query: string): string[] {
  const chars = Array.from(query.toLocaleLowerCase());
  const terms =
    chars.length < 2 ? chars : chars.slice(1).map((c, i) => chars[i] + c);
  const unique = [...new Set(terms)];
  return [
    ...new Set([
      0,
      Math.floor(unique.length / 3),
      Math.floor((2 * unique.length) / 3),
      unique.length - 1,
    ]),
  ].map((i) => token(key, unique[i]));
}
export async function indexMarketListing(
  tx: MarketTransaction,
  cipher: EncryptedFieldCipher,
  listing: Listing,
  key?: Buffer,
) {
  const [existing] = await tx.all(
    'SELECT version FROM park_market_search_documents WHERE listing_id=?',
    [listing.id],
  );
  if (Number(existing?.version) === listing.version) return;
  await tx.run('DELETE FROM park_market_search_terms WHERE listing_id=?', [
    listing.id,
  ]);
  if (
    ['active', 'reserved'].includes(listing.state) &&
    listing.cleanedAt === null
  ) {
    const secret =
      key ?? (await marketSearchKey(tx, cipher, listing.parkId, true))!;
    const values = grams(`${listing.title}\n${listing.description}`).map(
      (term) => token(secret, term),
    );
    for (let start = 0; start < values.length; start += 200) {
      const chunk = values.slice(start, start + 200);
      await tx.run(
        `INSERT INTO park_market_search_terms VALUES ${chunk.map(() => '(?,?,?)').join(',')}`,
        chunk.flatMap((value) => [listing.parkId, value, listing.id]),
      );
    }
  }
  await tx.run(
    'INSERT INTO park_market_search_documents VALUES (?,?) ON CONFLICT(listing_id) DO UPDATE SET version=excluded.version',
    [listing.id, listing.version],
  );
}

// The version table is the persistent work queue: a committed current version is
// complete; missing/stale versions survive restarts without an in-memory cursor.
export async function marketSearchPending(
  tx: MarketTransaction,
  park?: string,
) {
  return (
    (
      await tx.all(
        `SELECT l.id FROM park_market_listings l
    WHERE l.state IN ('active','reserved') ${park ? 'AND l.park_id=?' : ''}
    AND NOT EXISTS (SELECT 1 FROM park_market_search_documents d WHERE d.listing_id=l.id AND d.version=l.version)
    LIMIT 1`,
        park ? [park] : [],
      )
    ).length > 0
  );
}
export async function backfillMarketSearch(
  deps: {
    repository: import('./fleaMarketRepository.js').MarketRepository;
    cipher: EncryptedFieldCipher;
  },
  limit = 100,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250)
    throw new Error('INVALID_SEARCH_BATCH');
  return deps.repository.transaction(async (tx) => {
    const rows = await tx.all(
      `SELECT l.* FROM park_market_listings l
      WHERE l.state IN ('active','reserved') AND NOT EXISTS
      (SELECT 1 FROM park_market_search_documents d WHERE d.listing_id=l.id AND d.version=l.version)
      ORDER BY l.id LIMIT ?`,
      [limit],
    );
    for (const row of rows) {
      const listing: Listing = JSON.parse(
        deps.cipher.decryptText(
          JSON.parse(String(row.payload)),
          `park-market-listing:${row.id}`,
        ),
      );
      await indexMarketListing(tx, deps.cipher, listing);
    }
    return { indexed: rows.length, pending: await marketSearchPending(tx) };
  });
}

/** Internal maintenance operation; callers must use the deployment's operator boundary.
 * Clearing document versions and terms with the new key is atomic. Requests report
 * backfill pending until the bounded worker has rebuilt every live document.
 */
export async function rotateMarketSearchKey(
  deps: {
    repository: import('./fleaMarketRepository.js').MarketRepository;
    cipher: EncryptedFieldCipher;
  },
  park: string,
) {
  await deps.repository.transaction(async (tx) => {
    await tx.run('DELETE FROM park_market_search_terms WHERE park_id=?', [
      park,
    ]);
    await tx.run(
      'DELETE FROM park_market_search_documents WHERE listing_id IN (SELECT id FROM park_market_listings WHERE park_id=?)',
      [park],
    );
    await tx.run('DELETE FROM park_market_search_keys WHERE park_id=?', [park]);
    await marketSearchKey(tx, deps.cipher, park, true);
  });
}

export const MARKET_SEARCH_SCAN_SCHEMA_SQL = `
CREATE INDEX IF NOT EXISTS park_market_search_pending ON park_market_listings(park_id,state,id,version);
CREATE INDEX IF NOT EXISTS park_market_live_latest ON park_market_listings(park_id,listed_at DESC,id) WHERE state IN ('active','reserved');
CREATE INDEX IF NOT EXISTS park_market_live_price_asc ON park_market_listings(park_id,price_cents ASC,listed_at DESC,id) WHERE state IN ('active','reserved');
CREATE INDEX IF NOT EXISTS park_market_live_price_desc ON park_market_listings(park_id,price_cents DESC,listed_at DESC,id) WHERE state IN ('active','reserved');
`;
