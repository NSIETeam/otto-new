import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketDraftStore } from './park-market.js';
import { ParkMarketMessaging } from './park-market-messaging.js';
it('retains both ciphertext receipts across concurrent timeouts and retries identical bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'market-send-race-'));
  try {
    const pending = new MarketDraftStore(
      root,
      (text) => Buffer.from(text),
      (bytes) => bytes.toString(),
    );
    const scope = {
      server: 'https://market.test',
      organization: 'org',
      account: 'buyer',
    };
    const encryptMessage = vi.fn((input) => ({
      messageId: input.messageId,
      ciphertext: `encrypted-${input.messageId}`,
    }));
    const context = {
      accountId: scope.account,
      organizationId: scope.organization,
      serverUrl: scope.server,
      serverScope: scope.server,
      requiresMls: false,
      crypto: { encryptMessage },
    };
    const sent: unknown[] = [];
    let fail = true;
    const request = vi.fn(async (_path, method, body) => {
      if (method !== 'POST')
        return {
          conversationId: 'conversation',
          parkId: 'park',
          peerId: 'seller',
          directories: [],
        };
      sent.push(body);
      if (fail) throw new Error('connection lost after send');
      return { sent: true };
    });
    const messaging = new ParkMarketMessaging({
      context: () => context as never,
      ensureDevice: async () => {},
      request,
      pending,
    });
    const one = {
      kind: 'listing' as const,
      id: 'listing',
      question: 'one',
      requestId: 'one',
    };
    const two = { ...one, question: 'two', requestId: 'two' };
    await Promise.allSettled([messaging.send(one), messaging.send(two)]);
    expect(
      pending
        .load(scope)
        .map((item) => item.id)
        .sort(),
    ).toEqual(['one', 'two']);
    fail = false;
    await Promise.all([messaging.send(one), messaging.send(two)]);
    expect(sent.slice(2)).toEqual(sent.slice(0, 2));
    expect(encryptMessage).toHaveBeenCalledTimes(2);
    expect(pending.load(scope)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('discards retry ciphertext only when the server explicitly rejects the transaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'market-send-rejected-'));
  try {
    const pending = new MarketDraftStore(
      root,
      (text) => Buffer.from(text),
      (bytes) => bytes.toString(),
    );
    const scope = {
      server: 'https://market.test',
      organization: 'org',
      account: 'buyer',
    };
    const context = {
      accountId: scope.account,
      organizationId: scope.organization,
      serverUrl: scope.server,
      serverScope: scope.server,
      requiresMls: false,
      crypto: {
        encryptMessage: (input: { messageId: string }) => ({
          messageId: input.messageId,
          ciphertext: 'fixture',
          attachments: [
            {
              id: 'file',
              nonce: 'nonce',
              ciphertext: Buffer.alloc(17).toString('base64'),
            },
          ],
        }),
        signParkMarketMls: () => ({
          deviceId: 'device',
          signature: 'signature',
        }),
      },
    };
    const messaging = new ParkMarketMessaging({
      context: () => context as never,
      ensureDevice: async () => {},
      pending,
      uploadAttachment: async () => undefined,
      request: async (_path, method) => {
        if (method !== 'POST')
          return {
            conversationId: 'conversation',
            parkId: 'park',
            peerId: 'seller',
            directories: [],
          };
        throw Object.assign(new Error('CONFLICT'), { status: 409 });
      },
    });
    const orphan=join(pending.attachmentDirectory(scope),'orphan');
    writeFileSync(orphan,'ciphertext');utimesSync(orphan,new Date(0),new Date(0));
    await expect(
      messaging.send({
        kind: 'conversation',
        id: 'listing',
        question: '问题',
        requestId: 'rejected',
        attachments: [
          {
            fileName: 'file.txt',
            mimeType: 'text/plain',
            size: 1,
            data: 'eA==',
          },
        ],
      }),
    ).rejects.toThrow(/明确未发送/);
    expect(pending.load(scope)).toEqual([]);
    expect(readdirSync(pending.attachmentDirectory(scope))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
