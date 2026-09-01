/**
 * SQLite CURRENT_TIMESTAMP values are UTC but do not carry a timezone suffix.
 * Normalize them at the repository boundary so every client receives an
 * unambiguous ISO-8601 instant.
 */
const SQLITE_TIMESTAMP_WITHOUT_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;

export function normalizeSqliteUtcTimestamp(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const normalized = SQLITE_TIMESTAMP_WITHOUT_TIMEZONE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
