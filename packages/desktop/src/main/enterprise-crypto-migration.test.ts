/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnterpriseE2eeCrypto, EnterpriseE2eeKeyVault } from './enterprise-e2ee.js';
import { FileEnterpriseMlsMessageHistory } from './enterprise-mls-private-messages.js';
import { EnterpriseClient } from './enterprise-client.js';

const oldUrl = 'https://59.110.154.44:7777';
const newUrl = 'https://101.200.190.204:7777';
const legacyUrls = [oldUrl, 'https://59.110.154.44', 'https://59.110.154.44:443',
  'https://59-110-154-44.sslip.io', 'https://59-110-154-44.sslip.io:443', 'https://59-110-154-44.sslip.io:7777'];
const roots: string[] = [];
const storage = {
  assertAvailable() {},
  protect: (value: string) => `protected:${Buffer.from(value).toString('base64')}`,
  unprotect: (value: string) => Buffer.from(value.slice(10), 'base64').toString(),
};
function endpoint() {
  const root = mkdtempSync(join(tmpdir(), 'otto-crypto-migration-'));
  roots.push(root);
  const vault = new EnterpriseE2eeKeyVault({ directory: root, ...storage });
  return { root, vault, crypto: new EnterpriseE2eeCrypto(vault) };
}
function snapshot(root: string) {
  return readdirSync(root).sort().map(name => [name, readFileSync(join(root, name)).toString('base64')]);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('encrypted identity continuity after endpoint migration', () => {
  it('registers the original device through the NEW endpoint after a real client login', async () => {
    const original = endpoint();
    const device = original.crypto.localDevice(oldUrl, 'alice');
    const calls: string[] = [];
    const client = new EnterpriseClient(async (input, init) => {
      const url = String(input);
      calls.push(url);
      expect(url.startsWith(newUrl + '/')).toBe(true);
      let body: unknown;
      if (url.endsWith('/health')) body = { status: 'ok', apiVersion: 4, capabilities: ['password_auth', 'e2ee_private_messages_v1'] };
      else if (url.endsWith('/auth/login')) body = { token: 'synthetic-token', account: { id: 'alice', organizationId: 'org' }, expiresAt: '2099-01-01' };
      else if (url.endsWith('/e2ee/devices')) {
        expect(JSON.parse(String(init?.body)).deviceId).toBe(device.deviceId);
        body = { device: { ...device, approvalState: 'approved', revokedAt: null } };
      } else if (url.includes('/key-transparency?')) body = { transparency: { accountId: 'alice', headSequence: 0, headHash: '0'.repeat(64), entries: [] } };
      else throw new Error('Unexpected fixture request');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }, () => undefined, original.crypto);
    await client.loginWithPassword(newUrl, 'alice', 'synthetic-password');
    expect((await client.ensureE2eeDeviceReady()).deviceId).toBe(device.deviceId);
    expect(client.encryptionServerScope()).toBe(oldUrl);
    expect(client.snapshot().serverUrl).toBe(newUrl);
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it.each(legacyUrls)('retains device identity and every original byte from %s after restart', (origin) => {
    const original = endpoint();
    const device = original.crypto.localDevice(origin, 'alice');
    original.crypto.rotateLocalDevice(origin, 'alice');
    const before = snapshot(original.root);
    const restarted = new EnterpriseE2eeCrypto(new EnterpriseE2eeKeyVault({ directory: original.root, ...storage }));
    const scope = restarted.resolveServerScope(newUrl, 'alice');
    expect(scope).toBe(origin);
    expect(restarted.localDevice(scope, 'alice')).toEqual(original.crypto.localDevice(origin, 'alice'));
    expect(original.vault.loadOrCreate(scope, 'alice').historical[0].deviceId).toBe(device.deviceId);
    expect(snapshot(original.root)).toEqual(before);
  });

  it('decrypts old signed messages with the retained key, without contacting the old endpoint', () => {
    const alice = endpoint();
    const bob = endpoint();
    const sender = alice.crypto.localDevice(oldUrl, 'alice');
    const recipient = bob.crypto.localDevice(oldUrl, 'bob');
    const sent = alice.crypto.encryptMessage({ serverScope: oldUrl, organizationId: 'org', senderAccountId: 'alice', recipientAccountId: 'bob', content: 'synthetic historical message', contentType: 'message', devices: [sender, recipient] });
    const message = { ...sent, id: sent.messageId, senderAccountId: 'alice', recipientAccountId: 'bob', senderIdentitySigningPublicKey: sender.identitySigningPublicKey, createdAt: '2026-09-01T00:00:00Z', readAt: null, attachments: [] };
    const scope = bob.crypto.resolveServerScope(newUrl, 'bob');
    expect(bob.crypto.decryptMessage({ serverScope: scope, organizationId: 'org', accountId: 'bob', message }).content).toBe('synthetic historical message');
    expect(() => bob.crypto.decryptMessage({ serverScope: scope, organizationId: 'another-org', accountId: 'bob', message })).toThrow();
  });

  it('opens the existing encrypted MLS history and pending outbox under the original identity', async () => {
    const original = endpoint();
    const device = original.crypto.localDevice(oldUrl, 'alice');
    const store = new FileEnterpriseMlsMessageHistory({ directory: join(original.root, 'history'), secureStorage: storage });
    const identity = { serverUrl: oldUrl, organizationId: 'org', accountId: 'alice', deviceId: device.deviceId };
    const message = { id: 'mls-message-018f0000-0000-7000-8000-000000000001', senderAccountId: 'alice', recipientAccountId: 'bob', content: 'synthetic pending message', contentType: 'message' as const, inReplyToMessageId: null, createdAt: '2026-09-01T00:00:00Z', readAt: null, attachments: [], attachmentManifests: [], deliveryState: 'pending' as const, e2ee: true as const, e2eeProtocol: 'mls10-openmls-0.8' as const };
    await store.put(identity, 'bob', message);
    const reopened = new FileEnterpriseMlsMessageHistory({ directory: join(original.root, 'history'), secureStorage: storage });
    const migrated = { ...identity, serverUrl: original.crypto.resolveServerScope(newUrl, 'alice') };
    expect(await reopened.list(migrated, 'bob')).toEqual(await store.list(identity, 'bob'));
    expect((await reopened.list(migrated, 'bob'))[0].content).toBe(message.content);
    expect(await reopened.pendingOutgoing(migrated, 'bob')).toHaveLength(1);
    expect(await reopened.list({ ...migrated, organizationId: 'other' }, 'bob')).toEqual([]);
  });

  it('blocks conflicting old and new identities without modifying either', () => {
    const original = endpoint();
    original.crypto.localDevice(oldUrl, 'alice');
    original.crypto.localDevice(newUrl, 'alice');
    const before = snapshot(original.root);
    expect(() => original.crypto.resolveServerScope(newUrl, 'alice')).toThrow(/多套.*身份/);
    expect(snapshot(original.root)).toEqual(before);
  });

  it('blocks two legacy identities, even when one appears first in the allowlist', () => {
    const original = endpoint();
    original.crypto.localDevice(oldUrl, 'alice');
    original.crypto.localDevice(legacyUrls[3], 'alice');
    expect(() => original.crypto.resolveServerScope(newUrl, 'alice')).toThrow(/多套.*身份/);
  });

  it('keeps the old transparency pin and rejects a restored-server rollback', () => {
    const original = endpoint();
    const device = original.crypto.localDevice(oldUrl, 'alice');
    const entry = { sequence: 1, organizationId: 'org', accountId: 'alice', deviceId: device.deviceId, event: 'bootstrap_approved' as const, keyFingerprint: device.keyFingerprint, actorDeviceId: null, previousHash: '0'.repeat(64), createdAt: '2026-09-01T00:00:00Z' };
    const entryHash = createHash('sha256').update('otto:e2ee-key-transparency:v1\n').update(JSON.stringify(entry)).digest('hex');
    original.crypto.verifyAndPinKeyTransparency({ serverScope: oldUrl, organizationId: 'org', view: { accountId: 'alice', headSequence: 1, headHash: entryHash, entries: [{ ...entry, entryHash }] } });
    const before = snapshot(original.root);
    expect(() => original.crypto.verifyAndPinKeyTransparency({ serverScope: original.crypto.resolveServerScope(newUrl, 'alice'), organizationId: 'org', view: { accountId: 'alice', headSequence: 0, headHash: '0'.repeat(64), entries: [] } })).toThrow(/rollback/);
    expect(snapshot(original.root)).toEqual(before);
  });

  it('rejects a keyring copied from a different account', () => {
    const original = endpoint();
    original.crypto.localDevice(oldUrl, 'bob');
    const digest = (account: string) => `${createHash('sha256').update(`${oldUrl}\0${account}`).digest('hex')}.keyring`;
    writeFileSync(join(original.root, digest('alice')), readFileSync(join(original.root, digest('bob'))));
    expect(() => original.crypto.resolveServerScope(newUrl, 'alice')).toThrow(/keyring/);
  });

  it('does not silently create a replacement when the legacy keyring is corrupt', () => {
    const original = endpoint();
    const file = join(original.root, `${createHash('sha256').update(`${oldUrl}\0alice`).digest('hex')}.keyring`);
    writeFileSync(file, 'invalid ciphertext');
    const before = snapshot(original.root);
    expect(() => original.crypto.resolveServerScope(newUrl, 'alice')).toThrow();
    expect(snapshot(original.root)).toEqual(before);
  });

  it('preserves a new-endpoint-only identity, and isolates accounts', () => {
    const original = endpoint();
    original.crypto.localDevice(oldUrl, 'alice');
    const bob = original.crypto.localDevice(newUrl, 'bob');
    expect(original.crypto.resolveServerScope(newUrl, 'alice')).toBe(oldUrl);
    expect(original.crypto.resolveServerScope(newUrl, 'bob')).toBe(newUrl);
    expect(original.crypto.localDevice(newUrl, 'bob')).toEqual(bob);
  });

  it('uses the original deployment scope for fresh installations without generating keys during resolution', () => {
    const original = endpoint();
    expect(original.crypto.resolveServerScope(newUrl, 'new-user')).toBe(oldUrl);
    expect(readdirSync(original.root)).toEqual([]);
  });

  it.each(['https://private.example', `${newUrl}/tenant`, 'http://101.200.190.204:7777', 'https://101.200.190.204:8443', `${newUrl}?tenant=x`, 'https://101.200.190.204.attacker.test:7777'])('does not alias private or unapproved endpoint %s', (url) => {
    const original = endpoint();
    original.crypto.localDevice(oldUrl, 'alice');
    expect(original.crypto.resolveServerScope(url, 'alice')).toBe(url);
  });
});
