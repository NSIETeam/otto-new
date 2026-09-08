/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
/** SQLite numeric ids and PostgreSQL opaque ids; never URLs or path segments. */
export function isEnterpriseKnowledgeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(value)
  );
}
