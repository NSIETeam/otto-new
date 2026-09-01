const SERVER_TIMESTAMP_WITHOUT_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;

/**
 * Enterprise SQLite timestamps are UTC even though SQLite omits the suffix.
 * Keep explicit offsets intact and only annotate timezone-less values.
 */
export function normalizeEnterpriseServerTimestamp(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return SERVER_TIMESTAMP_WITHOUT_TIMEZONE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
}

export function parseEnterpriseServerTimestamp(value: string): number {
  const normalized = normalizeEnterpriseServerTimestamp(value);
  const parsed = normalized ? Date.parse(normalized) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
