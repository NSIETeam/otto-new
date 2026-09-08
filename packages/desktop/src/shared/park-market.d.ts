/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export interface MarketDesktopRequest {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
  imageBase64?: string;
  uploadId?: string;
}
export interface MarketDraftScope {
  server: string;
  organization: string;
  account: string;
}
export interface MarketDraft {
  id: string;
  [key: string]: unknown;
}
