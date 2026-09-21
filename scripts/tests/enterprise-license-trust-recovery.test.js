/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  applyLicenseTrustRecovery,
  canonicalRecoveryJson,
  licenseSigningKeyId,
  validateLicenseTrustRecovery,
} from '../../deployment/enterprise-oneclick/tools/license-trust-recovery.mjs';

function fixture() {
  const oldKeys = generateKeyPairSync('ed25519');
  const nextKeys = generateKeyPairSync('ed25519');
  const oldPublicKey = oldKeys.publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  const nextPublicKey = nextKeys.publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  const oldKeyId = licenseSigningKeyId(oldPublicKey);
  const nextKeyId = licenseSigningKeyId(nextPublicKey);
  const expiresAtMs = Date.UTC(2036, 6, 27, 3, 8, 3, 571);
  const status = {
    deploymentId: 'dep_recovered_instance',
    machineFingerprint: 'b'.repeat(64),
    license: {
      id: 'lic_original',
      revision: 1,
      deploymentId: 'dep_recovered_instance',
      organizationId: 'org_original',
      machineFingerprint: 'a'.repeat(64),
      customerName: 'Original Customer',
      plan: 'enterprise',
      expiresAt: new Date(expiresAtMs).toISOString(),
      seatLimit: 100,
      gracePeriodMs: 0,
      seatEnforcement: 'monitor',
      billingEnforcement: 'disabled',
      modules: ['direct_messages', 'enterprise_tree'],
      offline: true,
      telemetryAllowed: false,
      signatureAlgorithm: 'ed25519',
      signingKeyId: oldKeyId,
      status: 'invalid',
      enforce: true,
    },
  };
  const license = {
    id: status.license.id,
    deploymentId: status.deploymentId,
    organizationId: status.license.organizationId,
    machineFingerprint: status.machineFingerprint,
    customerName: status.license.customerName,
    plan: status.license.plan,
    expiresAtMs,
    seatLimit: status.license.seatLimit,
    gracePeriodMs: status.license.gracePeriodMs,
    seatEnforcement: status.license.seatEnforcement,
    billingEnforcement: status.license.billingEnforcement,
    modules: [...status.license.modules].reverse(),
    offline: status.license.offline,
    telemetryAllowed: status.license.telemetryAllowed,
    issuedAtMs: Date.UTC(2026, 8, 21, 0, 0, 0),
    revision: status.license.revision + 1,
  };
  const envelope = {
    license,
    signature: `ed25519:${sign(
      null,
      Buffer.from(canonicalRecoveryJson(license)),
      nextKeys.privateKey,
    ).toString('base64url')}`,
    signingKeyId: nextKeyId,
  };
  const recovery = {
    format: 'otto-license-trust-recovery-v1',
    reason: 'machine-replacement',
    prior: {
      licenseId: status.license.id,
      revision: status.license.revision,
      signingKeyId: oldKeyId,
      machineFingerprint: status.license.machineFingerprint,
    },
    envelope,
  };
  return {
    oldPublicKey,
    nextPublicKey,
    nextKeys,
    oldKeyId,
    nextKeyId,
    status,
    recovery,
  };
}

function resign(input) {
  input.recovery.envelope.signature = `ed25519:${sign(
    null,
    Buffer.from(canonicalRecoveryJson(input.recovery.envelope.license)),
    input.nextKeys.privateKey,
  ).toString('base64url')}`;
}

describe('enterprise License trust-root recovery', () => {
  it('accepts only an equal-entitlement machine replacement signed by a bundled key', () => {
    const input = fixture();
    const result = validateLicenseTrustRecovery({
      recovery: input.recovery,
      deploymentStatus: input.status,
      trustedPublicKeys: [input.oldPublicKey, input.nextPublicKey],
    });

    expect(result.mode).toBe('apply');
    expect(result.receipt).toMatchObject({
      format: 'otto-license-trust-recovery-receipt-v1',
      priorRevision: 1,
      acceptedRevision: 2,
      priorSigningKeyId: input.oldKeyId,
      acceptedSigningKeyId: input.nextKeyId,
    });
    expect(JSON.stringify(result.receipt)).not.toContain('machineFingerprint');
    expect(JSON.stringify(result.receipt)).not.toContain('telemetryToken');
  });

  it.each([
    ['seatLimit', (value) => (value.envelope.license.seatLimit += 1)],
    ['plan', (value) => (value.envelope.license.plan = 'ultimate')],
    ['expiry', (value) => (value.envelope.license.expiresAtMs += 1)],
    ['modules', (value) => value.envelope.license.modules.push('atoa')],
    ['organization', (value) => (value.envelope.license.organizationId = 'org_other')],
    ['deployment', (value) => (value.envelope.license.deploymentId = 'dep_other')],
    ['license id', (value) => (value.envelope.license.id = 'lic_other')],
  ])('rejects changed entitlement or identity: %s', (_name, mutate) => {
    const input = fixture();
    mutate(input.recovery);
    resign(input);
    expect(() =>
      validateLicenseTrustRecovery({
        recovery: input.recovery,
        deploymentStatus: input.status,
        trustedPublicKeys: [input.oldPublicKey, input.nextPublicKey],
      }),
    ).toThrow(/^license-recovery-/);
  });

  it('rejects a valid signature when its public key is not in the signed release', () => {
    const input = fixture();
    expect(() =>
      validateLicenseTrustRecovery({
        recovery: input.recovery,
        deploymentStatus: input.status,
        trustedPublicKeys: [input.oldPublicKey],
      }),
    ).toThrow('license-recovery-signing-key-untrusted');
  });

  it('rejects signature tampering, wrong current machine and skipped revisions', () => {
    const tampered = fixture();
    tampered.recovery.envelope.signature = tampered.recovery.envelope.signature.replace(
      /^ed25519:./,
      (prefix) => (prefix.endsWith('A') ? 'ed25519:B' : 'ed25519:A'),
    );
    expect(() =>
      validateLicenseTrustRecovery({
        recovery: tampered.recovery,
        deploymentStatus: tampered.status,
        trustedPublicKeys: [tampered.oldPublicKey, tampered.nextPublicKey],
      }),
    ).toThrow('license-recovery-signature-invalid');

    const wrongMachine = fixture();
    wrongMachine.recovery.envelope.license.machineFingerprint = 'c'.repeat(64);
    resign(wrongMachine);
    expect(() =>
      validateLicenseTrustRecovery({
        recovery: wrongMachine.recovery,
        deploymentStatus: wrongMachine.status,
        trustedPublicKeys: [wrongMachine.oldPublicKey, wrongMachine.nextPublicKey],
      }),
    ).toThrow('license-recovery-machine-mismatch');

    const skipped = fixture();
    skipped.recovery.envelope.license.revision = 3;
    resign(skipped);
    expect(() =>
      validateLicenseTrustRecovery({
        recovery: skipped.recovery,
        deploymentStatus: skipped.status,
        trustedPublicKeys: [skipped.oldPublicKey, skipped.nextPublicKey],
      }),
    ).toThrow('license-recovery-revision-invalid');
  });

  it('is idempotent after the exact recovered License is already active', () => {
    const input = fixture();
    input.status.license = {
      ...input.status.license,
      ...input.recovery.envelope.license,
      expiresAt: new Date(
        input.recovery.envelope.license.expiresAtMs,
      ).toISOString(),
      signingKeyId: input.nextKeyId,
      status: 'active',
    };
    const result = validateLicenseTrustRecovery({
      recovery: input.recovery,
      deploymentStatus: input.status,
      trustedPublicKeys: [input.oldPublicKey, input.nextPublicKey],
    });
    expect(result.mode).toBe('already-applied');
  });

  it('imports through the authenticated API and returns only a bounded receipt', async () => {
    const input = fixture();
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const responseBody = calls.length === 1
        ? input.status
        : {
            license: {
              ...input.status.license,
              ...input.recovery.envelope.license,
              expiresAt: new Date(
                input.recovery.envelope.license.expiresAtMs,
              ).toISOString(),
              signingKeyId: input.nextKeyId,
              status: 'active',
            },
          };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await applyLicenseTrustRecovery({
      baseUrl: 'http://127.0.0.1:17777',
      adminToken: 'test-admin-token-never-log-this',
      recovery: input.recovery,
      trustedPublicKeys: [input.oldPublicKey, input.nextPublicKey],
      fetchImpl,
    });

    expect(result.mode).toBe('applied');
    expect(calls.map(({ url }) => url)).toEqual([
      'http://127.0.0.1:17777/enterprise/deployment/status',
      'http://127.0.0.1:17777/enterprise/deployment/license',
    ]);
    expect(calls[1].init.headers['x-otto-admin-token']).toBe(
      'test-admin-token-never-log-this',
    );
    expect(calls[1].init.body).toBe(JSON.stringify(input.recovery.envelope));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-admin-token-never-log-this');
    expect(serialized).not.toContain(input.recovery.envelope.signature);
    expect(serialized).not.toContain('Original Customer');
  });

  it('never exposes a server response body or token when the import fails', async () => {
    const input = fixture();
    const secret = 'secret-response-body-that-must-not-escape';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(input.status), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(secret, { status: 400 }));

    await expect(
      applyLicenseTrustRecovery({
        baseUrl: 'http://127.0.0.1:17777',
        adminToken: 'test-admin-token-never-log-this',
        recovery: input.recovery,
        trustedPublicKeys: [input.oldPublicKey, input.nextPublicKey],
        fetchImpl,
      }),
    ).rejects.toThrow('license-recovery-import-failed');
    await expect(
      applyLicenseTrustRecovery({
        baseUrl: 'http://127.0.0.1:17777',
        adminToken: 'test-admin-token-never-log-this',
        recovery: input.recovery,
        trustedPublicKeys: [input.oldPublicKey, input.nextPublicKey],
        fetchImpl: vi.fn(async () => {
          throw new Error(secret);
        }),
      }),
    ).rejects.not.toThrow(secret);
  });

  it('uses hashes in receipts instead of License/customer material', () => {
    const input = fixture();
    const result = validateLicenseTrustRecovery({
      recovery: input.recovery,
      deploymentStatus: input.status,
      trustedPublicKeys: [input.oldPublicKey, input.nextPublicKey],
    });
    expect(result.receipt.licenseIdHash).toBe(
      createHash('sha256').update('lic_original').digest('hex'),
    );
    expect(Object.keys(result.receipt).sort()).toEqual([
      'acceptedRevision',
      'acceptedSigningKeyId',
      'entitlementDigest',
      'format',
      'licenseIdHash',
      'priorRevision',
      'priorSigningKeyId',
    ]);
  });
});
