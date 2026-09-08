/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { MarketServiceDependencies } from './fleaMarketService.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
import { MarketError, type Listing } from './fleaMarketTypes.js';
import { requireActive, canDiscover, samePark } from './fleaMarketAccess.js';
import { requestDisposition } from './fleaMarketRequestLifecycle.js';
import { createMarketUnitOfWork } from './fleaMarketUnitOfWork.js';
export const MARKET_CONTACT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS park_market_conversations (
 id TEXT PRIMARY KEY,park_id TEXT NOT NULL,account_a TEXT NOT NULL,account_b TEXT NOT NULL,state TEXT NOT NULL,created_at BIGINT NOT NULL,
 UNIQUE(park_id,account_a,account_b)
);
CREATE TABLE IF NOT EXISTS park_market_contact_requests (
 id TEXT PRIMARY KEY,park_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES park_market_conversations(id),
 listing_id TEXT NOT NULL REFERENCES park_market_listings(id),sender_id TEXT NOT NULL,recipient_id TEXT NOT NULL,
 state TEXT NOT NULL,ignored INTEGER NOT NULL DEFAULT 0,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS park_market_pending_pair ON park_market_contact_requests(conversation_id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS park_market_contact_expiry ON park_market_contact_requests(state,expires_at);
CREATE TABLE IF NOT EXISTS park_market_contact_days (
 park_id TEXT NOT NULL,sender_id TEXT NOT NULL,recipient_id TEXT NOT NULL,day TEXT NOT NULL,
 PRIMARY KEY(park_id,sender_id,recipient_id,day)
);`;
export interface MarketMessageAuthority {
  parkId: string;
  senderId: string;
  recipientId: string;
  messageId: string;
  conversationId: string;
}
export interface MarketContactDependencies extends MarketServiceDependencies {
  privateConversation?(
    tx: MarketTransaction,
    a: string,
    b: string,
  ): Promise<boolean>;
  directory?(
    tx: MarketTransaction,
    accounts: Array<{ accountId: string; organizationId: string }>,
  ): Promise<unknown>;
  verifyMessage(
    tx: MarketTransaction,
    context: MarketMessageAuthority,
    envelope: unknown,
  ): Promise<unknown>;
}
type Input = Record<string, unknown>;
type Conversation = {
  id: string;
  park_id: string;
  account_a: string;
  account_b: string;
  state: string;
  created_at: number;
};
type Contact = {
  id: string;
  park_id: string;
  conversation_id: string;
  listing_id: string;
  sender_id: string;
  recipient_id: string;
  state: 'pending' | 'accepted' | 'ended' | 'withdrawn' | 'expired';
  ignored: number;
  created_at: number;
  expires_at: number;
};
/** Called in the same transaction as each end-of-publication transition. */
export async function endMarketListingRequests(
  tx: MarketTransaction,
  id: string,
) {
  await tx.run(
    "UPDATE park_market_contact_requests SET state='ended' WHERE listing_id=? AND state='pending'",
    [id],
  );
}
export function createMarketContacts(deps: MarketContactDependencies) {
  const now = deps.now ?? Date.now;
  const unit = createMarketUnitOfWork(
    deps.repository,
    deps.cipher,
    async (tx, actor) => requireActive(await deps.principal(tx, actor)),
  );
  const execute = <T>(
    actor: string,
    action: string,
    id: string,
    input: Input,
    work: (tx: MarketTransaction) => Promise<T>,
  ) =>
    unit.execute(
      actor,
      String(input.requestId ?? ''),
      { action, id, input },
      work,
    );
  const decode = (payload: unknown, context: string) =>
    JSON.parse(deps.cipher.decryptText(JSON.parse(String(payload)), context));
  const encode = (payload: unknown, context: string) =>
    JSON.stringify(deps.cipher.encryptText(JSON.stringify(payload), context));
  async function listing(tx: MarketTransaction, id: string): Promise<Listing> {
    const [row] = await tx.all(
      'SELECT payload FROM park_market_listings WHERE id=?',
      [id],
    );
    if (!row) throw new MarketError('NOT_FOUND');
    return decode(row.payload, `park-market-listing:${id}`);
  }
  async function allowed(
    tx: MarketTransaction,
    park: string,
    a: string,
    b: string,
  ) {
    if (
      !samePark(await deps.principal(tx, a), park) ||
      !samePark(await deps.principal(tx, b), park)
    )
      return false;
    return !(
      await tx.all(
        'SELECT park_id FROM park_market_blocks WHERE park_id=? AND ((blocker_id=? AND peer_id=?) OR (blocker_id=? AND peer_id=?))',
        [park, a, b, b, a],
      )
    ).length;
  }
  async function conversation(
    tx: MarketTransaction,
    actor: string,
    id: string,
  ): Promise<Conversation> {
    const [row] = await tx.all<Conversation>(
      'SELECT * FROM park_market_conversations WHERE id=? AND (account_a=? OR account_b=?)',
      [id, actor, actor],
    );
    if (!row) throw new MarketError('NOT_FOUND');
    return row;
  }
  async function disposition(tx: MarketTransaction, request: Contact) {
    const item = await listing(tx, request.listing_id);
    const config = await deps.config(tx, request.park_id);
    const state = requestDisposition({
      state: request.state,
      expiresAt: Number(request.expires_at),
      now: now(),
      marketEnabled: config.enabled && config.ready,
      participantsAllowed: await allowed(
        tx,
        request.park_id,
        request.sender_id,
        request.recipient_id,
      ),
      listingState:
        item.expiresAt <= now() && ['active', 'reserved'].includes(item.state)
          ? 'offline'
          : item.state,
    });
    if (state === 'ended' || state === 'expired') {
      await tx.run(
        'UPDATE park_market_contact_requests SET state=? WHERE id=? AND state=?',
        [state, request.id, 'pending'],
      );
      request.state = state;
    }
    return state;
  }
  async function writeMessage(
    tx: MarketTransaction,
    actor: string,
    thread: Conversation,
    input: Input,
    item?: Listing,
  ) {
    const recipient =
      thread.account_a === actor ? thread.account_b : thread.account_a;
    const [{ count }] = await tx.all(
      'SELECT COUNT(*) AS count FROM park_contact_messages WHERE sender_id=? AND created_at>?',
      [actor, now() - 60_000],
    );
    if (Number(count) >= 60)
      throw new MarketError('LIMIT_REACHED', 'messageRate');
    const clientMessageId = String(input.requestId);
    const messageId = clientMessageId;
    if (
      (
        await tx.all('SELECT id FROM park_contact_messages WHERE id=?', [
          messageId,
        ])
      ).length
    )
      throw new MarketError('CONFLICT', 'messageId');
    const verified = await deps.verifyMessage(
      tx,
      {
        parkId: thread.park_id,
        senderId: actor,
        recipientId: recipient,
        messageId: clientMessageId,
        conversationId: thread.id,
      },
      input.envelope,
    );
    const snapshot = item
      ? {
          listingId: item.id,
          version: item.version,
          title: item.title,
          saleMode: item.saleMode,
          priceCents: item.priceCents,
          coverId: item.imageIds[0],
          sentAt: now(),
        }
      : null;
    await tx.run('INSERT INTO park_contact_messages VALUES (?,?,?,?,?,?,?)', [
      messageId,
      thread.park_id,
      thread.id,
      actor,
      recipient,
      now(),
      encode(
        { envelope: verified, snapshot },
        `park-contact-message:${messageId}`,
      ),
    ]);
    const [order] = await tx.all(
      'SELECT COALESCE(MAX(sequence),0) AS latest FROM park_contact_sequences WHERE conversation_id=?',
      [thread.id],
    );
    await tx.run('INSERT INTO park_contact_sequences VALUES (?,?,?)', [
      messageId,
      thread.id,
      Number(order.latest) + 1,
    ]);
    await tx.run(
      'INSERT INTO park_market_outbox(id,account_id,kind,object_id,object_version,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      [
        `contact:${messageId}`,
        recipient,
        thread.state === 'active' ? 'contact-message' : 'contact-request',
        thread.id,
        1,
        now(),
      ],
    );
    if (item)
      for (const account of [actor, recipient])
        await tx.run('INSERT INTO park_market_grants VALUES (?,?,?,?,?,?)', [
          thread.park_id,
          item.id,
          account,
          messageId,
          thread.id,
          now(),
        ]);
    return messageId;
  }
  return {
    async prepare(
      actorId: string,
      kind: 'listing' | 'conversation',
      id: string,
    ) {
      return deps.repository.transaction(async (tx) => {
        const actor = await deps.principal(tx, actorId);
        requireActive(actor);
        let parkId: string;
        let peerId: string;
        let version: number | null = null;
        if (kind === 'listing') {
          const item = await listing(tx, id);
          parkId = item.parkId;
          peerId = item.ownerId;
          version = item.version;
          if (
            peerId === actorId ||
            item.state !== 'active' ||
            item.expiresAt <= now() ||
            !canDiscover(actor, await deps.config(tx, parkId), parkId) ||
            !(await allowed(tx, parkId, actorId, peerId))
          )
            throw new MarketError('NOT_FOUND');
        } else {
          const thread = await conversation(tx, actorId, id);
          parkId = thread.park_id;
          peerId =
            thread.account_a === actorId ? thread.account_b : thread.account_a;
        }
        let conversationId = id;
        if (kind === 'listing') {
          const [a, b] = [actorId, peerId].sort();
          const [existing] = await tx.all(
            'SELECT id FROM park_market_conversations WHERE park_id=? AND account_a=? AND account_b=?',
            [parkId, a, b],
          );
          conversationId = existing ? String(existing.id) : randomUUID();
          if (!existing)
            await tx.run(
              'INSERT INTO park_market_conversations VALUES (?,?,?,?,?,?)',
              [conversationId, parkId, a, b, 'pending', now()],
            );
        }
        const peer = await deps.principal(tx, peerId);
        if (!peer || !deps.directory)
          throw new MarketError('DEPENDENCY_UNAVAILABLE');
        return {
          parkId,
          peerId,
          version,
          conversationId,
          directories: await deps.directory(tx, [actor, peer]),
        };
      });
    },
    async contact(
      actorId: string,
      listingId: string,
      input: Input,
    ): Promise<{
      conversationId: string;
      requestId: string | null;
      messageId: string;
    }> {
      return execute(actorId, 'contact', listingId, input, async (tx) => {
        const actor = await deps.principal(tx, actorId);
        requireActive(actor);
        const item = await listing(tx, listingId);
        const config = await deps.config(tx, item.parkId);
        if (
          item.ownerId === actorId ||
          !canDiscover(actor, config, item.parkId) ||
          !(await allowed(tx, item.parkId, actorId, item.ownerId))
        )
          throw new MarketError('NOT_FOUND');
        if (
          item.state !== 'active' ||
          item.expiresAt <= now() ||
          item.version !== input.expectedVersion
        )
          throw new MarketError('CONFLICT');
        const [a, b] = [actorId, item.ownerId].sort();
        let [thread] = await tx.all<Conversation>(
          'SELECT * FROM park_market_conversations WHERE park_id=? AND account_a=? AND account_b=?',
          [item.parkId, a, b],
        );
        if (!thread) {
          thread = {
            id: randomUUID(),
            park_id: item.parkId,
            account_a: a,
            account_b: b,
            state: 'pending',
            created_at: now(),
          };
          await tx.run(
            'INSERT INTO park_market_conversations VALUES (?,?,?,?,?,?)',
            [thread.id, thread.park_id, a, b, thread.state, now()],
          );
        }
        let requestId: string | null = null;
        const [pending] = await tx.all<Contact>(
          "SELECT * FROM park_market_contact_requests WHERE conversation_id=? AND state='pending'",
          [thread.id],
        );
        const privateGranted =
          (await deps.privateConversation?.(tx, a, b)) ?? false;
        if (privateGranted && thread.state !== 'active') {
          if (pending && (await disposition(tx, pending)) === 'actionable')
            await tx.run(
              "UPDATE park_market_contact_requests SET state='accepted' WHERE id=? AND state='pending'",
              [pending.id],
            );
          await tx.run(
            "UPDATE park_market_conversations SET state='active' WHERE id=?",
            [thread.id],
          );
          thread.state = 'active';
        }
        if (pending && !privateGranted) {
          const state = await disposition(tx, pending);
          if (state === 'paused') throw new MarketError('FORBIDDEN');
          if (state === 'actionable') {
            if (pending.sender_id === actorId)
              throw new MarketError('CONFLICT', 'pendingRequest');
            await tx.run(
              "UPDATE park_market_contact_requests SET state='accepted' WHERE id=?",
              [pending.id],
            );
            await tx.run(
              "UPDATE park_market_conversations SET state='active' WHERE id=?",
              [thread.id],
            );
            thread.state = 'active';
            requestId = pending.id;
          }
        }
        if (thread.state !== 'active') {
          const [last] = await tx.all(
            'SELECT created_at FROM park_market_contact_requests WHERE park_id=? AND listing_id=? AND sender_id=? ORDER BY created_at DESC LIMIT 1',
            [item.parkId, item.id, actorId],
          );
          if (last && Number(last.created_at) + 86400000 > now())
            throw new MarketError(
              'LIMIT_REACHED',
              'contactCooldown',
              Number(last.created_at) + 86400000,
            );
          const day = new Intl.DateTimeFormat('en-CA', {
            timeZone: config.timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(now());
          const prior = await tx.all(
            'SELECT recipient_id FROM park_market_contact_days WHERE park_id=? AND sender_id=? AND day=?',
            [item.parkId, actorId, day],
          );
          if (
            prior.length >= 10 ||
            prior.some((row) => row.recipient_id === item.ownerId)
          )
            throw new MarketError('LIMIT_REACHED', 'dailyContacts');
          await tx.run(
            'INSERT INTO park_market_contact_days VALUES (?,?,?,?)',
            [item.parkId, actorId, item.ownerId, day],
          );
          requestId = randomUUID();
          await tx.run(
            'INSERT INTO park_market_contact_requests VALUES (?,?,?,?,?,?,?,0,?,?)',
            [
              requestId,
              item.parkId,
              thread.id,
              item.id,
              actorId,
              item.ownerId,
              'pending',
              now(),
              now() + 7 * 86400000,
            ],
          );
        }
        return {
          conversationId: thread.id,
          requestId,
          messageId: await writeMessage(tx, actorId, thread, input, item),
        };
      });
    },
    async resolve(actorId: string, id: string, input: Input) {
      return execute(actorId, 'resolve-contact', id, input, async (tx) => {
        const [request] = await tx.all<Contact>(
          'SELECT * FROM park_market_contact_requests WHERE id=? AND (sender_id=? OR recipient_id=?)',
          [id, actorId, actorId],
        );
        if (!request) throw new MarketError('NOT_FOUND');
        const state = await disposition(tx, request);
        if (state !== 'actionable')
          throw new MarketError(state === 'paused' ? 'FORBIDDEN' : 'CONFLICT');
        if (input.action === 'withdraw' && request.sender_id === actorId)
          await tx.run(
            "UPDATE park_market_contact_requests SET state='withdrawn' WHERE id=?",
            [id],
          );
        else if (input.action === 'ignore' && request.recipient_id === actorId)
          await tx.run(
            'UPDATE park_market_contact_requests SET ignored=1 WHERE id=?',
            [id],
          );
        else if (
          ['accept', 'reply'].includes(String(input.action)) &&
          request.recipient_id === actorId
        ) {
          const thread = await conversation(
            tx,
            actorId,
            request.conversation_id,
          );
          if (input.action === 'reply') {
            thread.state = 'active';
            await writeMessage(tx, actorId, thread, input);
          }
          await tx.run(
            "UPDATE park_market_contact_requests SET state='accepted' WHERE id=?",
            [id],
          );
          await tx.run(
            "UPDATE park_market_conversations SET state='active' WHERE id=?",
            [request.conversation_id],
          );
        } else throw new MarketError('FORBIDDEN');
        return { id, conversationId: request.conversation_id };
      });
    },
    async send(actorId: string, id: string, input: Input) {
      return execute(actorId, 'send-contact', id, input, async (tx) => {
        const thread = await conversation(tx, actorId, id);
        if (
          thread.state !== 'active' ||
          !(await allowed(
            tx,
            thread.park_id,
            thread.account_a,
            thread.account_b,
          ))
        )
          throw new MarketError('FORBIDDEN');
        return { messageId: await writeMessage(tx, actorId, thread, input) };
      });
    },
    async block(actorId: string, peerId: string, input: Input) {
      return execute(actorId, 'market-block', peerId, input, async (tx) => {
        const actor = await deps.principal(tx, actorId);
        requireActive(actor);
        if (
          !actor.parkId ||
          peerId === actorId ||
          !samePark(await deps.principal(tx, peerId), actor.parkId) ||
          typeof input.enabled !== 'boolean'
        )
          throw new MarketError('NOT_FOUND');
        if (input.enabled) {
          await tx.run(
            'INSERT INTO park_market_blocks VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
            [actor.parkId, actorId, peerId, now()],
          );
          await tx.run(
            "UPDATE park_market_contact_requests SET state='ended' WHERE park_id=? AND state='pending' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))",
            [actor.parkId, actorId, peerId, peerId, actorId],
          );
        } else
          await tx.run(
            'DELETE FROM park_market_blocks WHERE park_id=? AND blocker_id=? AND peer_id=?',
            [actor.parkId, actorId, peerId],
          );
        return { success: true };
      });
    },
    async inbox(actorId: string, cursor?: string) {
      type Position = { at: number; id: string };
      let previous: { requests?: Position; conversations?: Position } = {};
      if (cursor !== undefined) {
        try {
          if (cursor.length > 2000) throw new Error();
          previous = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          if (
            !previous ||
            typeof previous !== 'object' ||
            Array.isArray(previous)
          )
            throw new Error();
          for (const value of Object.values(previous))
            if (
              !value ||
              !Number.isSafeInteger(value.at) ||
              value.at < 0 ||
              typeof value.id !== 'string' ||
              value.id.length > 300
            )
              throw new Error();
        } catch {
          throw new MarketError('INVALID_INPUT', 'cursor');
        }
      }
      return deps.repository.transaction(async (tx) => {
        requireActive(await deps.principal(tx, actorId));
        const requestPage = await tx.all<Contact>(
          `SELECT * FROM park_market_contact_requests WHERE (sender_id=? OR recipient_id=?) ${previous.requests ? 'AND (created_at<? OR (created_at=? AND id>?))' : ''} ORDER BY created_at DESC,id LIMIT 201`,
          [
            actorId,
            actorId,
            ...(previous.requests
              ? [
                  previous.requests.at,
                  previous.requests.at,
                  previous.requests.id,
                ]
              : []),
          ],
        );
        const requests = requestPage.slice(0, 200);
        const views = [];
        for (const request of requests) {
          const dispositionValue = await disposition(tx, request);
          views.push({
            ...request,
            ignored:
              request.recipient_id === actorId && Boolean(request.ignored),
            actionable: dispositionValue === 'actionable',
            paused: dispositionValue === 'paused',
          });
        }
        const conversationPage = await tx.all<Conversation>(
          `SELECT * FROM park_market_conversations WHERE (account_a=? OR account_b=?) AND state='active' ${previous.conversations ? 'AND (created_at<? OR (created_at=? AND id>?))' : ''} ORDER BY created_at DESC,id LIMIT 201`,
          [
            actorId,
            actorId,
            ...(previous.conversations
              ? [
                  previous.conversations.at,
                  previous.conversations.at,
                  previous.conversations.id,
                ]
              : []),
          ],
        );
        const conversations = conversationPage.slice(0, 200);
        const conversationViews = [];
        for (const thread of conversations) {
          const peer =
            thread.account_a === actorId ? thread.account_b : thread.account_a;
          const privateGranted =
            (await deps.privateConversation?.(tx, actorId, peer)) ?? false;
          conversationViews.push({
            ...thread,
            privatePeerId: privateGranted ? peer : null,
          });
        }
        const position = (
          rows: Array<{ id: string; created_at: number }>,
          fallback?: Position,
        ) =>
          rows.length
            ? { at: Number(rows.at(-1)!.created_at), id: rows.at(-1)!.id }
            : fallback;
        return {
          requests: views,
          conversations: conversationViews,
          nextCursor:
            requestPage.length > 200 || conversationPage.length > 200
              ? Buffer.from(
                  JSON.stringify({
                    requests: position(requests, previous.requests),
                    conversations: position(
                      conversations,
                      previous.conversations,
                    ),
                  }),
                ).toString('base64url')
              : null,
        };
      });
    },
    async associated(
      actorId: string,
      id: string,
      beforeSequence = Number.MAX_SAFE_INTEGER,
    ) {
      if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)
        throw new MarketError('INVALID_INPUT', 'beforeSequence');
      return deps.repository.read(async (tx) => {
        const actor = await deps.principal(tx, actorId);
        requireActive(actor);
        const thread = await conversation(tx, actorId, id);
        const rows = await tx.all(
          `SELECT g.listing_id,MAX(o.sequence) AS sequence
          FROM park_market_grants g JOIN park_contact_sequences o ON o.message_id=g.consultation_id
          WHERE g.conversation_id=? AND g.account_id=?
          GROUP BY g.listing_id HAVING MAX(o.sequence)<? ORDER BY MAX(o.sequence) DESC LIMIT 101`,
          [id, actorId, beforeSequence],
        );
        const items = [];
        for (const row of rows.slice(0, 100)) {
          const item = await listing(tx, String(row.listing_id));
          const [message] = await tx.all(
            `SELECT m.id,m.payload FROM park_contact_messages m
            JOIN park_contact_sequences o ON o.message_id=m.id WHERE m.conversation_id=? AND o.sequence=?`,
            [id, row.sequence],
          );
          if (!message) continue;
          const snapshot = decode(
            message.payload,
            `park-contact-message:${message.id}`,
          ).snapshot;
          const unavailable =
            !samePark(actor, thread.park_id) ||
            !samePark(await deps.principal(tx, item.ownerId), thread.park_id) ||
            ['deleted', 'removed'].includes(item.state) ||
            item.cleanedAt !== null;
          items.push({
            listingId: item.id,
            messageId: String(message.id),
            sequence: Number(row.sequence),
            title: unavailable
              ? '商品不可用'
              : String(snapshot?.title ?? item.title),
            unavailable,
          });
        }
        return {
          items,
          nextBeforeSequence:
            rows.length > 100 ? Number(rows[99].sequence) : null,
        };
      });
    },
    async messages(
      actorId: string,
      id: string,
      beforeSequence = Number.MAX_SAFE_INTEGER,
    ) {
      if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)
        throw new MarketError('INVALID_INPUT', 'beforeSequence');
      return deps.repository.read(async (tx) => {
        const actor = await deps.principal(tx, actorId);
        requireActive(actor);
        const thread = await conversation(tx, actorId, id);
        const page = await tx.all(
          'SELECT m.*,o.sequence,r.read_at FROM park_contact_messages m JOIN park_contact_sequences o ON o.message_id=m.id LEFT JOIN park_contact_read_receipts r ON r.message_id=m.id AND r.account_id=m.recipient_id WHERE m.conversation_id=? AND o.sequence<? ORDER BY o.sequence DESC LIMIT 201',
          [id, beforeSequence],
        );
        const rows = page.slice(0, 200).reverse();
        const items = [];
        for (const row of rows) {
          const payload = decode(row.payload, `park-contact-message:${row.id}`);
          let snapshot = payload.snapshot;
          if (snapshot) {
            const item = await listing(tx, snapshot.listingId);
            if (
              !samePark(actor, thread.park_id) ||
              !samePark(
                await deps.principal(tx, item.ownerId),
                thread.park_id,
              ) ||
              ['deleted', 'removed'].includes(item.state) ||
              item.cleanedAt !== null
            )
              snapshot = { ...snapshot, coverId: '', unavailable: true };
            snapshot = {
              ...snapshot,
              currentState: item.state,
              updated: item.version !== snapshot.version,
            };
          }
          items.push({
            id: String(row.id),
            sequence: Number(row.sequence),
            senderId: String(row.sender_id),
            recipientId: String(row.recipient_id),
            createdAt: Number(row.created_at),
            readAt: row.read_at === null ? null : Number(row.read_at),
            envelope: payload.envelope,
            snapshot,
          });
        }
        return {
          items,
          nextBeforeSequence:
            page.length > 200 ? Number(rows[0].sequence) : null,
          latestSequence: Number(rows.at(-1)?.sequence ?? 0),
          writable:
            thread.state === 'active' &&
            (await allowed(
              tx,
              thread.park_id,
              thread.account_a,
              thread.account_b,
            )),
          parkId: thread.park_id,
          peerId:
            thread.account_a === actorId ? thread.account_b : thread.account_a,
        };
      });
    },
    async read(
      actorId: string,
      id: string,
      throughSequence = Number.MAX_SAFE_INTEGER,
    ) {
      if (!Number.isSafeInteger(throughSequence) || throughSequence < 0)
        throw new MarketError('INVALID_INPUT', 'throughSequence');
      return deps.repository.transaction(async (tx) => {
        requireActive(await deps.principal(tx, actorId));
        await conversation(tx, actorId, id);
        const messages = await tx.all(
          'SELECT m.id FROM park_contact_messages m JOIN park_contact_sequences o ON o.message_id=m.id WHERE m.conversation_id=? AND m.recipient_id=? AND o.sequence<=?',
          [id, actorId, throughSequence],
        );
        for (const message of messages)
          await tx.run(
            'INSERT INTO park_contact_read_receipts VALUES (?,?,?) ON CONFLICT DO NOTHING',
            [actorId, message.id, now()],
          );
        await tx.run(
          "UPDATE park_market_notifications SET read_at=? WHERE account_id=? AND kind IN ('contact-request','contact-message') AND id IN (SELECT 'contact:' || m.id FROM park_contact_messages m JOIN park_contact_sequences o ON o.message_id=m.id WHERE m.conversation_id=? AND m.recipient_id=? AND o.sequence<=?) AND read_at IS NULL",
          [now(), actorId, id, actorId, throughSequence],
        );
        return { success: true };
      });
    },
  };
}
