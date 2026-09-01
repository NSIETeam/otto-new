const SERVER_TIMESTAMP_WITHOUT_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;

/** Treat timezone-less SQLite timestamps as UTC before local presentation. */
export function normalizeServerTimestamp(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return SERVER_TIMESTAMP_WITHOUT_TIMEZONE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
}

export function parseServerTimestamp(value: string): Date {
  return new Date(normalizeServerTimestamp(value) ?? value);
}

export function formatServerTimestamp(
  value: string,
  locales?: string | string[],
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = parseServerTimestamp(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(locales, options);
}
