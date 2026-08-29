/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { PARK_CORE_SCHEMA_CONTRIBUTOR } from './parkCoreSchema.js';
import {
  getEnterpriseParkStarMapFromRepository,
  getEnterprisePublicProfileFromRepository,
  updateEnterprisePublicProfileInRepository,
  type ParkPartnershipRepositoryStore,
} from './parkPartnershipRepository.js';

function setup() {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, park_id TEXT, status TEXT NOT NULL
    );
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    INSERT INTO organizations VALUES
      ('org-admin', '园区运营方', NULL, 'active'),
      ('org-a', '甲企业', 'park-a', 'active'),
      ('org-b', '乙企业', 'park-a', 'active'),
      ('org-private', '未公开企业', 'park-a', 'active');
    INSERT INTO accounts VALUES ('admin-a'), ('member-a'), ('admin-b'), ('private-admin');
  `);
  PARK_CORE_SCHEMA_CONTRIBUTOR.apply(database);
  database.exec(`
    INSERT INTO parks
      (id, name, slug, invite_secret, admin_organization_id, brand_name)
    VALUES
      ('park-a', '宏创园区', 'hongchuang', 'secret', 'org-admin', '宏创园区服务');
  `);
  const accounts = new Map([
    ['admin-a', { id: 'admin-a', organizationId: 'org-a', isAdmin: true, status: 'active' }],
    ['member-a', { id: 'member-a', organizationId: 'org-a', isAdmin: false, status: 'active' }],
    ['admin-b', { id: 'admin-b', organizationId: 'org-b', isAdmin: true, status: 'active' }],
    ['private-admin', { id: 'private-admin', organizationId: 'org-private', isAdmin: true, status: 'active' }],
  ]);
  const organizations = new Map(
    (database.prepare('SELECT id, name, status FROM organizations').all() as Array<{
      id: string;
      name: string;
      status: string;
    }>).map((organization) => [organization.id, organization]),
  );
  const store: ParkPartnershipRepositoryStore = {
    db: () => database,
    getAccount: (accountId, organizationId) => {
      const account = accounts.get(accountId);
      return account && (!organizationId || account.organizationId === organizationId)
        ? account
        : null;
    },
    getOrganization: (organizationId) => organizations.get(organizationId) ?? null,
    getParkForOrganization: (organizationId) => {
      const row = database
        .prepare(
          `SELECT park.* FROM parks park
           LEFT JOIN organizations organization ON organization.park_id = park.id
           WHERE park.admin_organization_id = ? OR organization.id = ?
           LIMIT 1`,
        )
        .get(organizationId, organizationId) as Record<string, unknown> | undefined;
      return row
        ? {
            id: String(row.id),
            name: String(row.name),
            slug: String(row.slug),
            adminOrganizationId: String(row.admin_organization_id),
            brandName: String(row.brand_name),
            status: 'active',
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
          }
        : null;
    },
    normalizeOptionalText: (value, _field, maximum = 500) => {
      const normalized = value.trim();
      if (normalized.length > maximum) throw new Error('too long');
      return normalized || null;
    },
    nowISO: () => '2026-08-29T08:00:00.000Z',
    audit: () => undefined,
  };
  return { database, store };
}

const publicInput = {
  summary: '为园区企业提供数字化服务',
  website: 'https://example.com',
  industryTags: ['软件'],
  productsServices: ['园区数字化改造'],
  capabilities: ['软件开发'],
  cooperationNeeds: ['法律咨询'],
  publicContact: '合作邮箱 bd@example.com',
  isPublic: true,
};

describe('park partnership repository', () => {
  it('keeps a new profile private and only lets an active admin publish it', () => {
    const { database, store } = setup();
    try {
      expect(getEnterprisePublicProfileFromRepository(store, 'org-a')).toMatchObject({
        organizationName: '甲企业',
        isPublic: false,
      });
      expect(() =>
        updateEnterprisePublicProfileInRepository(store, {
          ...publicInput,
          organizationId: 'org-a',
          actorAccountId: 'member-a',
        }),
      ).toThrow('只有企业管理员');
      expect(
        updateEnterprisePublicProfileInRepository(store, {
          ...publicInput,
          organizationId: 'org-a',
          actorAccountId: 'admin-a',
        }),
      ).toMatchObject({ isPublic: true, organizationName: '甲企业' });
    } finally {
      database.close();
    }
  });

  it('excludes private organizations and returns evidence-based park edges', () => {
    const { database, store } = setup();
    try {
      updateEnterprisePublicProfileInRepository(store, {
        ...publicInput,
        organizationId: 'org-a',
        actorAccountId: 'admin-a',
      });
      updateEnterprisePublicProfileInRepository(store, {
        ...publicInput,
        organizationId: 'org-b',
        actorAccountId: 'admin-b',
        productsServices: ['法律咨询服务'],
        capabilities: ['法律咨询'],
        cooperationNeeds: ['软件开发'],
      });
      updateEnterprisePublicProfileInRepository(store, {
        ...publicInput,
        organizationId: 'org-private',
        actorAccountId: 'private-admin',
        isPublic: false,
      });

      const map = getEnterpriseParkStarMapFromRepository(store, 'org-a');
      expect(map.nodes.map((node) => node.organizationId).sort()).toEqual(['org-a', 'org-b']);
      expect(map.edges).toHaveLength(1);
      expect(map.edges[0]!.evidence.join(' ')).toContain('公开需求');
      expect(map.nodes.some((node) => node.publicContact.includes('bd@'))).toBe(true);
    } finally {
      database.close();
    }
  });
});
