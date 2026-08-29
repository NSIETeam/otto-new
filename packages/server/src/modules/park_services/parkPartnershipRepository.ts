/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { inferParkPartnerships } from './parkPartnershipInference.js';
import type {
  EnterpriseParkStarMap,
  EnterprisePublicProfile,
  EnterprisePublicProfileInput,
} from './parkPartnershipTypes.js';
import type { ParkView } from './parkLifecycleTypes.js';

interface ProfileAccount {
  id: string;
  isAdmin: boolean;
  status: string;
}
interface ProfileOrganization {
  id: string;
  name: string;
  status: string;
}

interface ProfileRow {
  organization_id: string;
  organization_name: string;
  summary: string;
  website: string;
  industry_tags_json: string;
  products_services_json: string;
  capabilities_json: string;
  cooperation_needs_json: string;
  public_contact: string;
  is_public: number;
  updated_at: string | null;
}

export interface ParkPartnershipRepositoryStore {
  db(): Database;
  getAccount(accountId: string, organizationId?: string): ProfileAccount | null;
  getOrganization(organizationId: string): ProfileOrganization | null;
  getParkForOrganization(organizationId: string): ParkView | null;
  normalizeOptionalText(
    value: string,
    field: string,
    maxLength?: number,
  ): string | null;
  nowISO(): string;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

export interface UpdateEnterprisePublicProfileInput
  extends EnterprisePublicProfileInput {
  organizationId: string;
  actorAccountId: string;
}

function parseStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizeList(
  store: ParkPartnershipRepositoryStore,
  values: string[],
  label: string,
): string[] {
  if (!Array.isArray(values)) throw new Error(`${label}格式不正确`);
  const normalized = values
    .map((value) =>
      typeof value === 'string'
        ? store.normalizeOptionalText(value, label, 80)
        : null,
    )
    .filter((value): value is string => Boolean(value));
  const unique = Array.from(new Set(normalized));
  if (unique.length > 20) throw new Error(`${label}最多填写20项`);
  return unique;
}

function profileFromRow(row: ProfileRow): EnterprisePublicProfile {
  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    summary: row.summary,
    website: row.website,
    industryTags: parseStringList(row.industry_tags_json),
    productsServices: parseStringList(row.products_services_json),
    capabilities: parseStringList(row.capabilities_json),
    cooperationNeeds: parseStringList(row.cooperation_needs_json),
    publicContact: row.public_contact,
    isPublic: row.is_public === 1,
    updatedAt: row.updated_at,
  };
}

function defaultProfile(organization: ProfileOrganization): EnterprisePublicProfile {
  return {
    organizationId: organization.id,
    organizationName: organization.name,
    summary: '',
    website: '',
    industryTags: [],
    productsServices: [],
    capabilities: [],
    cooperationNeeds: [],
    publicContact: '',
    isPublic: false,
    updatedAt: null,
  };
}

export function getEnterprisePublicProfileFromRepository(
  store: ParkPartnershipRepositoryStore,
  organizationId: string,
): EnterprisePublicProfile {
  const organization = store.getOrganization(organizationId);
  if (!organization) throw new Error('企业不存在');
  const row = store
    .db()
    .prepare(
      `SELECT profile.*, organization.name AS organization_name
       FROM enterprise_public_profiles profile
       INNER JOIN organizations organization
         ON organization.id = profile.organization_id
       WHERE profile.organization_id = ?`,
    )
    .get(organizationId) as ProfileRow | undefined;
  return row ? profileFromRow(row) : defaultProfile(organization);
}

export function updateEnterprisePublicProfileInRepository(
  store: ParkPartnershipRepositoryStore,
  input: UpdateEnterprisePublicProfileInput,
): EnterprisePublicProfile {
  const actor = store.getAccount(input.actorAccountId, input.organizationId);
  if (!actor?.isAdmin || actor.status !== 'active') {
    throw new Error('只有企业管理员可修改和发布企业资料');
  }
  const organization = store.getOrganization(input.organizationId);
  if (!organization || organization.status !== 'active') {
    throw new Error('企业不存在或已停用');
  }
  const summary =
    store.normalizeOptionalText(input.summary, '企业简介', 1000) ?? '';
  const website = store.normalizeOptionalText(input.website, '企业官网', 300) ?? '';
  if (website && !/^https?:\/\//i.test(website)) {
    throw new Error('企业官网必须以 http:// 或 https:// 开头');
  }
  const publicContact =
    store.normalizeOptionalText(input.publicContact, '公开联系方式', 240) ?? '';
  const industryTags = normalizeList(store, input.industryTags, '行业标签');
  const productsServices = normalizeList(
    store,
    input.productsServices,
    '产品与服务',
  );
  const capabilities = normalizeList(store, input.capabilities, '企业能力');
  const cooperationNeeds = normalizeList(
    store,
    input.cooperationNeeds,
    '合作需求',
  );
  if (
    input.isPublic &&
    (!summary ||
      productsServices.length + capabilities.length + cooperationNeeds.length ===
        0)
  ) {
    throw new Error('公开企业资料前请填写简介及至少一项产品、能力或合作需求');
  }
  const updatedAt = store.nowISO();
  store
    .db()
    .prepare(
      `INSERT INTO enterprise_public_profiles (
         organization_id, summary, website, industry_tags_json,
         products_services_json, capabilities_json, cooperation_needs_json,
         public_contact, is_public, updated_by_account_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET
         summary = excluded.summary,
         website = excluded.website,
         industry_tags_json = excluded.industry_tags_json,
         products_services_json = excluded.products_services_json,
         capabilities_json = excluded.capabilities_json,
         cooperation_needs_json = excluded.cooperation_needs_json,
         public_contact = excluded.public_contact,
         is_public = excluded.is_public,
         updated_by_account_id = excluded.updated_by_account_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.organizationId,
      summary,
      website,
      JSON.stringify(industryTags),
      JSON.stringify(productsServices),
      JSON.stringify(capabilities),
      JSON.stringify(cooperationNeeds),
      publicContact,
      input.isPublic ? 1 : 0,
      input.actorAccountId,
      updatedAt,
    );
  store.audit(
    'enterprise_public_profile_updated',
    input.actorAccountId,
    JSON.stringify({
      isPublic: input.isPublic,
      industryTagCount: industryTags.length,
      productServiceCount: productsServices.length,
      capabilityCount: capabilities.length,
      cooperationNeedCount: cooperationNeeds.length,
    }),
    input.organizationId,
  );
  return getEnterprisePublicProfileFromRepository(store, input.organizationId);
}

export function getEnterpriseParkStarMapFromRepository(
  store: ParkPartnershipRepositoryStore,
  organizationId: string,
): EnterpriseParkStarMap {
  const park = store.getParkForOrganization(organizationId);
  if (!park) throw new Error('当前企业尚未加入产业园');
  const rows = store
    .db()
    .prepare(
      `SELECT profile.*, organization.name AS organization_name
       FROM enterprise_public_profiles profile
       INNER JOIN organizations organization
         ON organization.id = profile.organization_id
       WHERE profile.is_public = 1
         AND organization.status = 'active'
         AND (organization.id = ? OR organization.park_id = ?)
       ORDER BY organization.name COLLATE NOCASE, organization.id`,
    )
    .all(park.adminOrganizationId, park.id) as ProfileRow[];
  const nodes = rows.map(profileFromRow);
  return {
    parkId: park.id,
    parkName: park.name,
    currentOrganizationId: organizationId,
    generatedAt: store.nowISO(),
    nodes,
    edges: inferParkPartnerships(nodes),
  };
}
