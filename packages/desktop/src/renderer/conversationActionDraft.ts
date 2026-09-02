/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

export type ConversationActionDraftSource =
  | 'repair'
  | 'park-service'
  | 'customer-module';

export interface ConversationActionDraftSummary {
  id: string;
  source: ConversationActionDraftSource;
  title: string;
  phase: 'collecting' | 'awaiting_confirmation' | 'submitting' | 'failed';
  updatedAt: number;
  expiresAt: number;
  missingFields: string[];
  confirmationText?: string;
  incursCost?: boolean;
}

export function conversationDraftExpiryLabel(expiresAt: number, now: number): string {
  const remaining = Math.max(0, expiresAt - now);
  if (remaining < 60_000) return '即将过期';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes} 分钟后过期`;
  return `${Math.ceil(minutes / 60)} 小时后过期`;
}
