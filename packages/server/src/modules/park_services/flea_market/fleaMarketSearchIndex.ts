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
