/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

/**
 * Stable provenance carried by installable modules and function groups.
 * `third-party` is intentionally part of the persisted contract before the
 * developer marketplace is enabled, so later packages do not require another
 * workspace schema migration.
 */
export type ComponentPackageSource = 'official' | 'user' | 'third-party';

export interface ComponentPackageReference {
  source: ComponentPackageSource;
  packageId: string;
  publisherId: string;
  version: string;
}

export const OTTO_OFFICIAL_PUBLISHER_ID = 'otto.official';
export const LOCAL_USER_PUBLISHER_ID = 'otto.local-user';

export function normalizeComponentPackageReference(
  value: unknown,
): ComponentPackageReference | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const source = record.source;
  const packageId = typeof record.packageId === 'string' ? record.packageId.trim() : '';
  const publisherId = typeof record.publisherId === 'string' ? record.publisherId.trim() : '';
  const version = typeof record.version === 'string' ? record.version.trim() : '';
  if (
    source !== 'official'
    && source !== 'user'
    && source !== 'third-party'
  ) return undefined;
  if (!packageId || !publisherId || !version) return undefined;
  return { source, packageId, publisherId, version };
}
