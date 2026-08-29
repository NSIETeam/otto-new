/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonChannelOutboundLedgerV1 } from './channelOutboundLedger.js';

const roots: string[] = [];
const hash = 'a'.repeat(64);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-channel-outbound-'));
  roots.push(root);
  let now = 100;
  return {
    root,
    ledger: new JsonChannelOutboundLedgerV1(
      path.join(root, 'outbound.json'),
      () => now++,
    ),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('JsonChannelOutboundLedgerV1', () => {
  it('recovers a failed write with the same key and commits exactly one receipt', async () => {
    const { ledger } = fixture();
    const input = {
      idempotencyKey: 'msg:0123456789abcdef',
      installationId: 'channel_lark_0123456789abcdef01234567',
      provider: 'lark' as const,
      requestHash: hash,
    };
    expect((await ledger.prepare(input)).attempts).toBe(1);
    expect((await ledger.fail(input.idempotencyKey, hash, 'timeout')).state).toBe('failed');
    expect((await ledger.prepare(input)).attempts).toBe(2);
    const committed = await ledger.commit(input.idempotencyKey, hash, 'om_message_1');
    expect(committed).toMatchObject({
      state: 'committed',
      attempts: 2,
      receipt: { idempotencyKey: input.idempotencyKey, providerMessageId: 'om_message_1' },
    });
    expect((await ledger.prepare(input)).attempts).toBe(2);
    expect((await ledger.commit(input.idempotencyKey, hash, 'om_message_1')).receipt)
      .toEqual(committed.receipt);
  });

  it('rejects key reuse for a different request or installation', async () => {
    const { ledger } = fixture();
    const input = {
      idempotencyKey: 'msg:0123456789abcdef',
      installationId: 'channel_lark_0123456789abcdef01234567',
      provider: 'lark' as const,
      requestHash: hash,
    };
    await ledger.prepare(input);
    await expect(ledger.prepare({ ...input, requestHash: 'b'.repeat(64) }))
      .rejects.toThrow('idempotency conflict');
    await expect(ledger.prepare({ ...input, installationId: 'channel_lark_abcdef0123456789abcdef01' }))
      .rejects.toThrow('idempotency conflict');
  });

  it('stores hashes and states without message content', async () => {
    const { root, ledger } = fixture();
    await ledger.prepare({
      idempotencyKey: 'msg:0123456789abcdef',
      installationId: 'channel_wecom_0123456789abcdef01234567',
      provider: 'wecom',
      requestHash: hash,
    });
    const raw = fs.readFileSync(path.join(root, 'outbound.json'), 'utf8');
    expect(raw).toContain(hash);
    expect(raw).not.toContain('message body');
    expect(fs.statSync(path.join(root, 'outbound.json')).mode & 0o777).toBe(0o600);
  });
});
