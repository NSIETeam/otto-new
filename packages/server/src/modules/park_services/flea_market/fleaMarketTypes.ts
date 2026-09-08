/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export type MarketErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LIMIT_REACHED'
  | 'DEPENDENCY_UNAVAILABLE';
export class MarketError extends Error {
  constructor(
    readonly code: MarketErrorCode,
    readonly field?: string,
    readonly retryAt?: number,
  ) {
    super(code);
    this.name = 'MarketError';
  }
}
export const categories = [
  'electronics',
  'office',
  'home',
  'sports',
  'books',
  'other',
] as const;
export const conditions = ['unused', 'like_new', 'used', 'worn'] as const;
export const functionStatuses = ['working', 'faulty', 'untested'] as const;
export type ListingState =
  'active' | 'reserved' | 'offline' | 'sold' | 'removed' | 'deleted';
export interface ListingFields {
  title: string;
  category: (typeof categories)[number];
  saleMode: 'sale' | 'free';
  priceCents: number;
  negotiable: boolean;
  condition: (typeof conditions)[number];
  functionStatus: (typeof functionStatuses)[number];
  faultDescription: string;
  description: string;
  handoverArea: string;
  handoverTime: string;
  imageIds: string[];
}
export interface Reservation {
  expectedAt: number | null;
  note: string;
  cycle: number;
  reminderVersion: number;
  remindAt: number;
}
export interface Listing extends ListingFields {
  id: string;
  parkId: string;
  ownerId: string;
  version: number;
  state: ListingState;
  createdAt: number;
  listedAt: number;
  confirmedAt: number;
  expiresAt: number;
  updatedAt: number;
  reservation: Reservation | null;
  offlineAt: number | null;
  offlineReason: string | null;
  offlineVersion: number | null;
  soldAt: number | null;
  soldFrom: ListingState | null;
  lastRelistedAt: number | null;
  endedAt: number | null;
  cleanedAt: number | null;
}
export type PublicListing = ListingFields & {
  seller?: { nickname: string };
} & Pick<
    Listing,
    'id' | 'version' | 'state' | 'listedAt' | 'confirmedAt' | 'expiresAt'
  >;
export type OwnListing = Listing;
export interface ListingSnapshot {
  listingId: string;
  version: number;
  title: string;
  saleMode: 'sale' | 'free';
  priceCents: number;
  coverId: string;
  sentAt: number;
}
export type RequestState =
  'pending' | 'accepted' | 'withdrawn' | 'expired' | 'ended';
export interface ContactRequest {
  id: string;
  parkId: string;
  senderId: string;
  recipientId: string;
  listingId: string;
  state: RequestState;
  ignored: boolean;
  createdAt: number;
  expiresAt: number;
  snapshot: ListingSnapshot;
}
export interface MarketNotification {
  id: string;
  accountId: string;
  kind: string;
  objectId: string;
  objectVersion: number;
  createdAt: number;
  readAt: number | null;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface MarketPrincipal {
  nickname?: string;
  accountId: string;
  organizationId: string;
  active: boolean;
  parkId: string | null;
  parkActive: boolean;
  enterpriseEnabled: boolean;
  marketAdminParkIds: string[];
}
export interface MarketConfig {
  enabled: boolean;
  ready: boolean;
  timezone: string;
  rules: string;
  responsibleAccountId: string;
  contact: string;
}
export interface WriteCommand {
  requestId: string;
  expectedVersion?: number;
}
