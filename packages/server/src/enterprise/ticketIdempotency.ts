/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const TICKET_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u;

export type TicketIdempotencyHeader =
  | { valid: true; key: string | null }
  | { valid: false; key: null };

export function readTicketIdempotencyHeader(
  req: IncomingMessage,
): TicketIdempotencyHeader {
  const raw = req.headers['x-otto-idempotency-key'];
  if (raw === undefined) return { valid: true, key: null };
  if (Array.isArray(raw)) return { valid: false, key: null };
  const key = raw.trim();
  if (key !== raw || !TICKET_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return { valid: false, key: null };
  }
  return { valid: true, key };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function ticketRequestFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

export function ticketIdempotencyResourceId(input: {
  organizationId: string;
  accountId: string;
  key: string;
}): string {
  const digest = createHash('sha256')
    .update(input.organizationId, 'utf8')
    .update('\0')
    .update(input.accountId, 'utf8')
    .update('\0')
    .update(input.key, 'utf8')
    .digest('hex');
  return `ticket_idem_${digest.slice(0, 48)}`;
}
