#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * One-time, fail-closed License trust-root recovery for a machine replacement.
 * The candidate License must be signed by a key bundled in the signed target
 * release and must preserve every effective entitlement of the installed
 * License. Only the machine fingerprint, issuance time and next revision may
 * change. No License body, token or customer name is returned in receipts.
 */

import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';

const FORMAT = 'otto-license-trust-recovery-v1';
const RECEIPT_FORMAT = 'otto-license-trust-recovery-receipt-v1';
const SIGNATURE_PREFIX = 'ed25519:';
const MAX_RESPONSE_BYTES = 1024 * 1024;

function reject(code) {
  throw new Error(`license-recovery-${code}`);
}

function object(value, code = 'document-invalid') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code);
  return value;
}

function exactKeys(value, keys, code = 'document-invalid') {
  const actual = Object.keys(object(value, code)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) reject(code);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalRecoveryJson(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizedPublicKey(value) {
  if (typeof value !== 'string' || value.length > 32 * 1024)
    reject('public-key-invalid');
  const trimmed = value.trim().replace(/\\n/g, '\n');
  try {
    if (trimmed.includes('BEGIN PUBLIC KEY')) return createPublicKey(trimmed);
    return createPublicKey({
      key: Buffer.from(trimmed, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    reject('public-key-invalid');
  }
}

export function licenseSigningKeyId(publicKey) {
  const der = normalizedPublicKey(publicKey).export({
    format: 'der',
    type: 'spki',
  });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) reject(code);
  return value;
}

function nonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) reject(code);
  return value;
}

function nonemptyString(value, code) {
  if (typeof value !== 'string' || !value || value.length > 4096) reject(code);
  return value;
}

function modules(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256 ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(item),
    )
  ) {
    reject('modules-invalid');
  }
  const sorted = [...new Set(value)].sort();
  if (sorted.length !== value.length) reject('modules-invalid');
  return sorted;
}

function candidatePayload(raw) {
  const payload = object(raw, 'payload-invalid');
  const required = [
    'billingEnforcement',
    'customerName',
    'deploymentId',
    'expiresAtMs',
    'gracePeriodMs',
    'id',
    'issuedAtMs',
    'machineFingerprint',
    'modules',
    'offline',
    'organizationId',
    'plan',
    'revision',
    'seatEnforcement',
    'seatLimit',
    'telemetryAllowed',
  ];
  const allowed = new Set([...required, 'telemetryToken']);
  const keys = Object.keys(payload);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    reject('payload-fields-invalid');
  }
  for (const key of [
    'id',
    'deploymentId',
    'organizationId',
    'machineFingerprint',
    'customerName',
    'plan',
  ]) {
    nonemptyString(payload[key], 'payload-field-invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(payload.machineFingerprint))
    reject('machine-mismatch');
  positiveInteger(payload.expiresAtMs, 'expiry-invalid');
  positiveInteger(payload.issuedAtMs, 'issued-at-invalid');
  positiveInteger(payload.seatLimit, 'seat-limit-invalid');
  positiveInteger(payload.revision, 'revision-invalid');
  nonnegativeInteger(payload.gracePeriodMs, 'grace-invalid');
  if (payload.seatEnforcement !== 'monitor') reject('entitlement-changed');
  if (payload.billingEnforcement !== 'disabled') reject('entitlement-changed');
  if (payload.offline !== true) reject('entitlement-changed');
  if (typeof payload.telemetryAllowed !== 'boolean')
    reject('telemetry-invalid');
  if (
    payload.telemetryAllowed &&
    (typeof payload.telemetryToken !== 'string' ||
      payload.telemetryToken.length < 32 ||
      payload.telemetryToken.length > 4096)
  ) {
    reject('telemetry-token-invalid');
  }
  if (!payload.telemetryAllowed && 'telemetryToken' in payload)
    reject('telemetry-token-unexpected');
  modules(payload.modules);
  return payload;
}

function statusLicense(raw) {
  const status = object(raw, 'status-invalid');
  const license = object(status.license, 'status-invalid');
  nonemptyString(status.deploymentId, 'status-invalid');
  if (
    typeof status.machineFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(status.machineFingerprint)
  ) {
    reject('status-invalid');
  }
  return { status, license };
}

function effectiveEntitlements(value, candidate = false) {
  const expiry = candidate
    ? value.expiresAtMs
    : Date.parse(String(value.expiresAt || ''));
  if (!Number.isFinite(expiry)) reject('status-invalid');
  return {
    billingEnforcement: value.billingEnforcement,
    customerName: value.customerName,
    expiresAtMs: expiry,
    gracePeriodMs: value.gracePeriodMs,
    modules: modules(value.modules),
    offline: value.offline,
    organizationId: value.organizationId,
    plan: value.plan,
    seatEnforcement: value.seatEnforcement,
    seatLimit: value.seatLimit,
    telemetryAllowed: value.telemetryAllowed,
  };
}

function trustedKeyForEnvelope(envelope, trustedPublicKeys) {
  if (
    !Array.isArray(trustedPublicKeys) ||
    trustedPublicKeys.length < 1 ||
    trustedPublicKeys.length > 32
  ) {
    reject('trust-set-invalid');
  }
  const match = trustedPublicKeys.find((publicKey) => {
    try {
      return licenseSigningKeyId(publicKey) === envelope.signingKeyId;
    } catch {
      return false;
    }
  });
  if (!match) reject('signing-key-untrusted');
  return normalizedPublicKey(match);
}

function verifyEnvelope(envelope, publicKey) {
  if (
    typeof envelope.signature !== 'string' ||
    !envelope.signature.startsWith(SIGNATURE_PREFIX)
  ) {
    reject('signature-invalid');
  }
  let signature;
  try {
    signature = Buffer.from(
      envelope.signature.slice(SIGNATURE_PREFIX.length),
      'base64url',
    );
  } catch {
    reject('signature-invalid');
  }
  if (
    signature.length !== 64 ||
    !verify(
      null,
      Buffer.from(canonicalRecoveryJson(envelope.license)),
      publicKey,
      signature,
    )
  ) {
    reject('signature-invalid');
  }
}

function receiptFor(prior, envelope, entitlements) {
  return {
    format: RECEIPT_FORMAT,
    licenseIdHash: createHash('sha256')
      .update(envelope.license.id)
      .digest('hex'),
    entitlementDigest: createHash('sha256')
      .update(canonicalRecoveryJson(entitlements))
      .digest('hex'),
    priorRevision: prior.revision,
    acceptedRevision: envelope.license.revision,
    priorSigningKeyId: prior.signingKeyId,
    acceptedSigningKeyId: envelope.signingKeyId,
  };
}

export function validateLicenseTrustRecovery({
  recovery: rawRecovery,
  deploymentStatus,
  trustedPublicKeys,
}) {
  const recovery = object(rawRecovery);
  exactKeys(recovery, ['format', 'reason', 'prior', 'envelope']);
  if (
    recovery.format !== FORMAT ||
    recovery.reason !== 'machine-replacement'
  ) {
    reject('document-invalid');
  }
  const prior = object(recovery.prior);
  exactKeys(prior, [
    'licenseId',
    'machineFingerprint',
    'revision',
    'signingKeyId',
  ]);
  nonemptyString(prior.licenseId, 'prior-invalid');
  positiveInteger(prior.revision, 'prior-invalid');
  if (!/^[a-f0-9]{64}$/.test(prior.machineFingerprint))
    reject('prior-invalid');
  if (!/^[a-f0-9]{16}$/.test(prior.signingKeyId)) reject('prior-invalid');

  const envelope = object(recovery.envelope);
  exactKeys(envelope, ['license', 'signature', 'signingKeyId']);
  if (!/^[a-f0-9]{16}$/.test(envelope.signingKeyId))
    reject('signing-key-invalid');
  const license = candidatePayload(envelope.license);
  const publicKey = trustedKeyForEnvelope(envelope, trustedPublicKeys);
  verifyEnvelope(envelope, publicKey);

  const { status, license: installed } = statusLicense(deploymentStatus);
  const alreadyApplied =
    installed.id === license.id &&
    installed.revision === license.revision &&
    installed.signingKeyId === envelope.signingKeyId &&
    installed.machineFingerprint === status.machineFingerprint;
  if (alreadyApplied) {
    const current = effectiveEntitlements(installed);
    const requested = effectiveEntitlements(license, true);
    if (canonicalRecoveryJson(current) !== canonicalRecoveryJson(requested))
      reject('entitlement-changed');
    if (!['active', 'expiring', 'grace'].includes(installed.status))
      reject('already-applied-unusable');
    return {
      mode: 'already-applied',
      receipt: receiptFor(prior, envelope, requested),
    };
  }

  if (
    installed.id !== prior.licenseId ||
    installed.id !== license.id ||
    installed.revision !== prior.revision ||
    installed.signingKeyId !== prior.signingKeyId ||
    installed.machineFingerprint !== prior.machineFingerprint ||
    installed.deploymentId !== status.deploymentId ||
    license.deploymentId !== status.deploymentId
  ) {
    reject('prior-identity-mismatch');
  }
  if (
    installed.signatureAlgorithm !== 'ed25519' ||
    installed.status !== 'invalid'
  ) {
    reject('prior-state-invalid');
  }
  if (
    envelope.signingKeyId === prior.signingKeyId ||
    license.revision !== prior.revision + 1
  ) {
    reject('revision-invalid');
  }
  if (
    license.machineFingerprint !== status.machineFingerprint ||
    license.machineFingerprint === prior.machineFingerprint
  ) {
    reject('machine-mismatch');
  }
  const installedEntitlements = effectiveEntitlements(installed);
  const requestedEntitlements = effectiveEntitlements(license, true);
  if (
    canonicalRecoveryJson(installedEntitlements) !==
    canonicalRecoveryJson(requestedEntitlements)
  ) {
    reject('entitlement-changed');
  }
  return {
    mode: 'apply',
    receipt: receiptFor(prior, envelope, requestedEntitlements),
  };
}

async function boundedJsonRequest(url, options, code) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let reader;
  try {
    const response = await options.fetchImpl(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) reject(code);
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES)
      reject(code);
    reader = response.body?.getReader();
    if (!reader) reject(code);
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) reject(code);
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      reject(code);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `license-recovery-${code}`)
      throw error;
    reject(code);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

export async function applyLicenseTrustRecovery({
  baseUrl,
  adminToken,
  recovery,
  trustedPublicKeys,
  fetchImpl = fetch,
}) {
  if (
    typeof baseUrl !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(baseUrl) ||
    typeof adminToken !== 'string' ||
    adminToken.length < 16
  ) {
    reject('request-invalid');
  }
  const headers = { 'x-otto-admin-token': adminToken };
  const status = await boundedJsonRequest(
    `${baseUrl}/enterprise/deployment/status`,
    { method: 'GET', headers, fetchImpl },
    'status-failed',
  );
  const validation = validateLicenseTrustRecovery({
    recovery,
    deploymentStatus: status,
    trustedPublicKeys,
  });
  if (validation.mode === 'already-applied') return validation;
  const imported = await boundedJsonRequest(
    `${baseUrl}/enterprise/deployment/license`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(recovery.envelope),
      fetchImpl,
    },
    'import-failed',
  );
  const importedLicense = object(imported.license, 'import-failed');
  if (
    importedLicense.id !== recovery.envelope.license.id ||
    importedLicense.revision !== recovery.envelope.license.revision ||
    importedLicense.machineFingerprint !==
      recovery.envelope.license.machineFingerprint ||
    importedLicense.signingKeyId !== recovery.envelope.signingKeyId ||
    !['active', 'expiring', 'grace'].includes(importedLicense.status)
  ) {
    reject('import-result-invalid');
  }
  return { mode: 'applied', receipt: validation.receipt };
}
