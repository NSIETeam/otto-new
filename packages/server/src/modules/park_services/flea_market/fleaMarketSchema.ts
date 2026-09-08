import {
  PARK_CONTACT_ATTACHMENT_SCHEMA_SQL,
  PARK_CONTACT_UPLOAD_INTENT_SCHEMA_SQL,
} from '../../collaboration/parkContactAttachments.js';
import { MARKET_MAINTENANCE_SCHEMA_SQL, MARKET_CLEANUP_SCAN_SCHEMA_SQL } from './fleaMarketJobs.js';
import {
  MARKET_SEARCH_SCAN_SCHEMA_SQL,
  MARKET_SEARCH_SCHEMA_SQL,
} from './fleaMarketSearchIndex.js';
import { MARKET_IMAGE_CHARGE_SCHEMA_SQL } from './fleaMarketStorageQuota.js';
import { PARK_CONTACT_MLS_SCHEMA_SQL } from '../../collaboration/parkContactMls.js';
import { MARKET_CONTACT_SCHEMA_SQL } from './fleaMarketContacts.js';
import {
  PARK_CONTACT_MESSAGE_SCHEMA_SQL,
  PARK_CONTACT_ORDER_SCHEMA_SQL,
} from '../../collaboration/parkContactCiphertext.js';
import { MARKET_ROLE_SCHEMA_SQL } from './fleaMarketRoles.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { MARKET_GOVERNANCE_SCHEMA_SQL } from './fleaMarketGovernance.js';
import type { DatabaseSchemaContributor } from '../../data_platform/index.js';
// Business schema is portable SQL. Time columns use integer milliseconds on both backends.
export const MARKET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS park_market_lock (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO park_market_lock(id) VALUES (1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS park_market_listings (
 id TEXT PRIMARY KEY, park_id TEXT NOT NULL, owner_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 state TEXT NOT NULL CHECK(state IN ('active','reserved','offline','sold','removed','deleted')),
 category TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>=0 AND price_cents<=99999999),
 listed_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, ended_at BIGINT,
 payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS park_market_discovery ON park_market_listings(park_id,state,listed_at,id);
CREATE INDEX IF NOT EXISTS park_market_price ON park_market_listings(park_id,state,price_cents,listed_at,id);
CREATE INDEX IF NOT EXISTS park_market_owner ON park_market_listings(owner_id,updated_at);
CREATE INDEX IF NOT EXISTS park_market_expiry ON park_market_listings(state,expires_at);
CREATE INDEX IF NOT EXISTS park_market_retention ON park_market_listings(ended_at);
CREATE TABLE IF NOT EXISTS park_market_operations (
 actor_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, created_at BIGINT NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE IF NOT EXISTS park_market_history (
 id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES park_market_listings(id), version INTEGER NOT NULL,
 actor_id TEXT NOT NULL, action TEXT NOT NULL, created_at BIGINT NOT NULL, payload TEXT NOT NULL,
 UNIQUE(listing_id,version)
);
CREATE TABLE IF NOT EXISTS park_market_quota (
 park_id TEXT NOT NULL, account_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, used INTEGER NOT NULL CHECK(used>=0),
 PRIMARY KEY(park_id,account_id,day,kind)
);
CREATE TABLE IF NOT EXISTS park_market_images (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, park_id TEXT NOT NULL, state TEXT NOT NULL,
 object_key TEXT, thumbnail_key TEXT, width INTEGER, height INTEGER, bytes BIGINT NOT NULL,
 created_at BIGINT NOT NULL, orphaned_at BIGINT
);
CREATE TABLE IF NOT EXISTS park_market_image_refs (
 image_id TEXT NOT NULL REFERENCES park_market_images(id), kind TEXT NOT NULL, object_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, expires_at BIGINT, PRIMARY KEY(image_id,kind,object_id)
);
CREATE INDEX IF NOT EXISTS park_market_image_lease ON park_market_image_refs(kind,expires_at);
CREATE TABLE IF NOT EXISTS park_market_favorites (
 account_id TEXT NOT NULL, listing_id TEXT NOT NULL REFERENCES park_market_listings(id), created_at BIGINT NOT NULL,
 PRIMARY KEY(account_id,listing_id)
);
CREATE TABLE IF NOT EXISTS park_market_blocks (
 park_id TEXT NOT NULL, blocker_id TEXT NOT NULL, peer_id TEXT NOT NULL, created_at BIGINT NOT NULL,
 PRIMARY KEY(park_id,blocker_id,peer_id)
);
CREATE TABLE IF NOT EXISTS park_market_grants (
 park_id TEXT NOT NULL, listing_id TEXT NOT NULL REFERENCES park_market_listings(id), account_id TEXT NOT NULL,
 consultation_id TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at BIGINT NOT NULL,
 PRIMARY KEY(park_id,listing_id,account_id,consultation_id)
);
CREATE INDEX IF NOT EXISTS park_market_grant_history ON park_market_grants(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS park_market_outbox (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL, object_version INTEGER NOT NULL,
 created_at BIGINT NOT NULL, delivered_at BIGINT, attempts INTEGER NOT NULL DEFAULT 0,
 lease_until BIGINT, lease_owner TEXT, retry_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS park_market_outbox_pending ON park_market_outbox(delivered_at,retry_at,lease_until);
CREATE TABLE IF NOT EXISTS park_market_notifications (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL, object_version INTEGER NOT NULL,
 created_at BIGINT NOT NULL, read_at BIGINT
);
CREATE INDEX IF NOT EXISTS park_market_unread ON park_market_notifications(account_id,read_at,created_at);
CREATE TABLE IF NOT EXISTS park_market_reports (
 id TEXT PRIMARY KEY, park_id TEXT NOT NULL, reporter_id TEXT NOT NULL, object_id TEXT NOT NULL,
 state TEXT NOT NULL, version INTEGER NOT NULL, created_at BIGINT NOT NULL, closed_at BIGINT, payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS park_market_report_pending ON park_market_reports(reporter_id,object_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS park_market_appeals (
 id TEXT PRIMARY KEY, park_id TEXT NOT NULL, owner_id TEXT NOT NULL, listing_id TEXT NOT NULL,
 state TEXT NOT NULL, version INTEGER NOT NULL, created_at BIGINT NOT NULL, closed_at BIGINT, payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS park_market_appeal_pending ON park_market_appeals(owner_id,listing_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS park_market_restrictions (
 id TEXT PRIMARY KEY, park_id TEXT NOT NULL, account_id TEXT NOT NULL, reason TEXT NOT NULL,
 expires_at BIGINT, revoked_at BIGINT, created_at BIGINT NOT NULL, actor_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS park_market_config (park_id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL);
`;
export const MARKET_PERSONAL_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS park_market_hidden_records(account_id TEXT NOT NULL,listing_id TEXT NOT NULL REFERENCES park_market_listings(id),created_at BIGINT NOT NULL,PRIMARY KEY(account_id,listing_id));`;
export const PARK_FLEA_MARKET_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'park_flea_market_v1',
  apply(db) {
    db.exec(MARKET_SCHEMA_SQL);
    db.exec(MARKET_GOVERNANCE_SCHEMA_SQL);
    db.exec(MARKET_ROLE_SCHEMA_SQL);
    db.exec(MARKET_CONTACT_SCHEMA_SQL);
    db.exec(PARK_CONTACT_MESSAGE_SCHEMA_SQL);
    db.exec(PARK_CONTACT_ORDER_SCHEMA_SQL);
    db.exec(PARK_CONTACT_MLS_SCHEMA_SQL);
    db.exec(MARKET_PERSONAL_SCHEMA_SQL);
    db.exec(MARKET_IMAGE_CHARGE_SCHEMA_SQL);
    db.exec(MARKET_SEARCH_SCHEMA_SQL);
    db.exec(MARKET_SEARCH_SCAN_SCHEMA_SQL);
    db.exec(MARKET_MAINTENANCE_SCHEMA_SQL);
    db.exec(PARK_CONTACT_ATTACHMENT_SCHEMA_SQL);
    db.exec(PARK_CONTACT_UPLOAD_INTENT_SCHEMA_SQL);
    db.exec(MARKET_CLEANUP_SCAN_SCHEMA_SQL);
  },
};
