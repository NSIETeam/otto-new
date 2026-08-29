/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

/** Stable account boundary for local workspace presentation preferences. */
export interface WorkspacePreferenceScope {
  serverUrl?: string | null;
  organizationId: string;
  accountId: string;
}
