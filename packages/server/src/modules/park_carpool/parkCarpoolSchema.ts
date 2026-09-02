/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const PARK_CARPOOL_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'park_carpool_v1',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS park_carpool_intents (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        park_id TEXT NOT NULL,
        travel_date TEXT NOT NULL,
        departure_time TEXT NOT NULL,
        flexible_minutes INTEGER NOT NULL CHECK(flexible_minutes BETWEEN 0 AND 120),
        travel_options TEXT NOT NULL,
        route_distance_meters INTEGER NOT NULL CHECK(route_distance_meters > 0),
        route_duration_seconds INTEGER NOT NULL CHECK(route_duration_seconds > 0),
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'grouped', 'expired')),
        sensitive_ciphertext TEXT NOT NULL,
        sensitive_iv TEXT NOT NULL,
        sensitive_auth_tag TEXT NOT NULL,
        sensitive_key_version INTEGER NOT NULL,
        last_confirmed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, travel_date),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_park_carpool_match
        ON park_carpool_intents(park_id, travel_date, status, departure_time);
      CREATE INDEX IF NOT EXISTS idx_park_carpool_owner
        ON park_carpool_intents(account_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_park_carpool_expiry
        ON park_carpool_intents(status, expires_at);
    `);
  },
};
