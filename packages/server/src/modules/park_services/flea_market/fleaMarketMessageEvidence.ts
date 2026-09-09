/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { MarketServiceDependencies } from './fleaMarketService.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
import { MarketError } from './fleaMarketTypes.js';
import { textField } from './fleaMarketValidation.js';
/** Voluntary plaintext disclosure, restricted to messages from the reporter's actual listing conversation. */
export async function selectedMarketMessageEvidence(
  deps: MarketServiceDependencies,
  tx: MarketTransaction,
  actor: string,
  listingId: string,
  parkId: string,
  input: unknown,
) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length < 1 || input.length > 10)
    throw new MarketError('INVALID_INPUT', 'selectedMessages');
  const selected = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== 'object')
      throw new MarketError('INVALID_INPUT', 'selectedMessages');
    const id = textField(value.id, 'messageId', 1, 128);
    if (seen.has(id))
      throw new MarketError('INVALID_INPUT', 'selectedMessages');
    seen.add(id);
    const [message] = await tx.all(
      `SELECT m.* FROM park_contact_messages m WHERE m.id=? AND m.park_id=? AND (m.sender_id=? OR m.recipient_id=?) AND EXISTS (SELECT 1 FROM park_market_grants g WHERE g.listing_id=? AND g.account_id=? AND g.conversation_id=m.conversation_id AND g.park_id=m.park_id)`,
      [id, parkId, actor, actor, listingId, actor],
    );
    if (!message) throw new MarketError('NOT_FOUND');
    const stored = JSON.parse(
      deps.cipher.decryptText(
        JSON.parse(String(message.payload)),
        `park-contact-message:${id}`,
      ),
    );
    selected.push({
      id,
      senderId: String(message.sender_id),
      recipientId: String(message.recipient_id),
      createdAt: Number(message.created_at),
      text: textField(value.text, 'selectedMessageText', 1, 5000),
      textSource: 'reporter-provided' as const,
      originalEnvelope: stored.envelope,
    });
  }
  return selected;
}
