/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createParkContactMls,
  parkMlsSignaturePayload,
  PARK_CONTACT_MLS_SCHEMA_SQL,
  type ParkMlsCommand,
} from '../../collaboration/parkContactMls.js';
import { sqliteMarketHarness } from './fleaMarketTestSupport.js';

it('MLS preparation claims recipient keys once, binds signatures and rejects revoked rosters', async () => {
  const h = await sqliteMarketHarness();
  try {
    let now = 100000;
    const keys = Object.fromEntries(
      ['buyer', 'seller'].map((id) => [id, generateKeyPairSync('ed25519')]),
    );
    const scopes = Object.fromEntries(
      ['buyer', 'seller'].map((id) => [
        id,
        `${'a'.repeat(64)}/E/${id}/device-${id}`,
      ]),
    );
    await h.repository.transaction(async (tx) => {
      await tx.run(
        'CREATE TABLE e2ee_devices(organization_id TEXT,account_id TEXT,device_id TEXT,identity_signing_public_key TEXT,approval_state TEXT,revoked_at TEXT)',
      );
      for (const statement of PARK_CONTACT_MLS_SCHEMA_SQL.split(';').filter(
        (s) => s.trim(),
      ))
        await tx.run(statement);
      for (const id of ['buyer', 'seller'])
        await tx.run('INSERT INTO e2ee_devices VALUES (?,?,?,?,?,NULL)', [
          'E',
          id,
          `device-${id}`,
          keys[id].publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          'approved',
        ]);
    });
    const mls = createParkContactMls({
      now: () => now,
      authorize: async (_tx, actor, id) => {
        if (!['buyer', 'seller'].includes(actor) || id !== 'conversation')
          throw new Error('not a participant');
        return { parkId: 'P', a: 'buyer', b: 'seller' };
      },
    });
    const command = (
      actor: string,
      action: ParkMlsCommand['action'],
      payload: Record<string, unknown>,
    ): ParkMlsCommand => ({
      action,
      deviceId: `device-${actor}`,
      payload,
      signature: sign(
        null,
        parkMlsSignaturePayload(action, actor, `device-${actor}`, payload),
        keys[actor].privateKey,
      ).toString('base64'),
    });
    const run = (actor: string, c: ParkMlsCommand) =>
      h.repository.transaction((tx) => mls.execute(tx, actor, c));
    const packageCommand = command('seller', 'package', {
      device_scope: scopes.seller,
      reference: 'b'.repeat(64),
      key_package: Buffer.from('native-key-package-fixture').toString('base64'),
    });
    expect(await run('seller', packageCommand)).toEqual({ usable: true });
    const prepare = command('buyer', 'state', {
      conversationId: 'conversation',
      deviceScope: scopes.buyer,
      prepare: true,
    });
    const initial = await run('buyer', prepare);
    expect(initial).toMatchObject({
      generation: 1,
      sessions: [
        {
          state: 'preparing',
          initialization: { packages: [{ device_scope: scopes.seller }] },
        },
      ],
    });
    expect(await run('buyer', prepare)).toEqual(initial);
    expect(await run('seller', packageCommand)).toEqual({ usable: false });
    await expect(
      run('seller', { ...prepare, deviceId: 'device-seller' }),
    ).rejects.toThrow('signature');
    if (!('sessions' in initial)) throw new Error('missing sessions');
    await run(
      'buyer',
      command('buyer', 'activate', {
        conversationId: 'conversation',
        deviceScope: scopes.buyer,
        generation: 1,
        leaseId: initial.sessions![0].initialization!.leaseId,
        groupId: 'Z3JvdXA=',
        welcome: 'd2VsY29tZQ==',
      }),
    );
    const payload = {
      conversationId: 'conversation',
      generation: 1,
      groupId: 'Z3JvdXA=',
      epoch: 1,
      ciphertext: 'Y2lwaGVydGV4dA==',
      eventId: 'buyer:message',
    };
    const packet = {
      encryption: 'mls' as const,
      messageId: 'message',
      deviceId: 'device-buyer',
      payload,
      signature: sign(
        null,
        parkMlsSignaturePayload('message', 'buyer', 'device-buyer', payload),
        keys.buyer.privateKey,
      ).toString('base64'),
    };
    expect(
      await h.repository.transaction((tx) =>
        mls.verify(tx, 'buyer', 'conversation', 'message', packet),
      ),
    ).toMatchObject({ senderScope: scopes.buyer });
    await h.repository.transaction((tx) =>
      tx.run(
        "UPDATE e2ee_devices SET revoked_at='now' WHERE account_id='seller'",
      ),
    );
    await expect(
      h.repository.transaction((tx) =>
        mls.verify(tx, 'buyer', 'conversation', 'message', packet),
      ),
    ).rejects.toThrow('recipient device');
    await h.repository.transaction((tx) =>
      tx.run(
        "UPDATE e2ee_devices SET revoked_at=NULL WHERE account_id='seller'",
      ),
    );
    await run(
      'seller',
      command('seller', 'package', {
        device_scope: scopes.seller,
        reference: 'c'.repeat(64),
        key_package: Buffer.from('second-key-package').toString('base64'),
      }),
    );
    const recovery = command('buyer', 'state', {
      conversationId: 'conversation',
      deviceScope: scopes.buyer,
      prepare: true,
      recoverGeneration: 1,
    });
    expect(await run('buyer', recovery)).toMatchObject({ generation: 2 });
    await expect(run('buyer', recovery)).rejects.toThrow(
      'recovery generation changed',
    );
    now += 61000;
  } finally {
    await h.close();
  }
});
