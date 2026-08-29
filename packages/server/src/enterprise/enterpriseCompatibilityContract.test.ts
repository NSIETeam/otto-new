/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  commercialFeatureForEnterpriseRoute,
} from '../modules/authorization/commercialRoutePolicy.js';
import {
  isLicenseMaintenanceRoute,
  isMemberRoute,
} from '../modules/authorization/enterpriseRoutePolicy.js';
import { e2eeProductionCapabilities } from './e2eeProductionReleasePolicy.js';
import { ENTERPRISE_CAPABILITIES } from './server.js';

/**
 * Frozen from production commit 82b5e0c. Keep this inventory independent of
 * current route declarations so deleting a production handler cannot make the
 * regression test update itself.
 */
const V1_9_13_PRODUCTION_ROUTE_LITERALS = [
  "/enterprise/account-sync",
  "/enterprise/accounts",
  "/enterprise/accounts/",
  "/enterprise/admin",
  "/enterprise/admin/credits",
  "/enterprise/admin/platform",
  "/enterprise/atoa",
  "/enterprise/atoa/inbox",
  "/enterprise/attachments",
  "/enterprise/attachments/inline",
  "/enterprise/attachments/uploads",
  "/enterprise/audit",
  "/enterprise/auth/",
  "/enterprise/auth/admin/login",
  "/enterprise/auth/join-organization",
  "/enterprise/auth/login",
  "/enterprise/auth/logout",
  "/enterprise/auth/me",
  "/enterprise/auth/register/sms/request",
  "/enterprise/auth/register/sms/verify",
  "/enterprise/auth/sms/request",
  "/enterprise/auth/sms/verify",
  "/enterprise/bootstrap/prepare",
  "/enterprise/credits/balance",
  "/enterprise/credits/redeem",
  "/enterprise/credits/redeem-codes",
  "/enterprise/credits/redeem-codes/",
  "/enterprise/credits/topup",
  "/enterprise/credits/transactions",
  "/enterprise/dashboard",
  "/enterprise/deployment/",
  "/enterprise/deployment/data-protection",
  "/enterprise/deployment/data-protection/backup",
  "/enterprise/deployment/diagnostics",
  "/enterprise/deployment/license",
  "/enterprise/deployment/license/lease",
  "/enterprise/deployment/status",
  "/enterprise/deployment/telemetry",
  "/enterprise/deployment/telemetry/flush",
  "/enterprise/deployment/telemetry/ingest",
  "/enterprise/deployment/update-policy",
  "/enterprise/e2ee",
  "/enterprise/e2ee/",
  "/enterprise/e2ee/devices",
  "/enterprise/e2ee/devices/",
  "/enterprise/e2ee/key-transparency",
  "/enterprise/e2ee/mls/inbound-conversations",
  "/enterprise/e2ee/mls/key-packages",
  "/enterprise/e2ee/mls/key-packages/claim",
  "/enterprise/e2ee/mls/key-packages/inventory",
  "/enterprise/employees",
  "/enterprise/export",
  "/enterprise/federation",
  "/enterprise/federation/",
  "/enterprise/federation/a2a",
  "/enterprise/federation/a2a/grants",
  "/enterprise/federation/a2a/grants/",
  "/enterprise/federation/admin/",
  "/enterprise/federation/admin/blocks",
  "/enterprise/federation/admin/blocks/",
  "/enterprise/federation/admin/provisioning",
  "/enterprise/federation/admin/run",
  "/enterprise/federation/admin/status",
  "/enterprise/federation/contacts",
  "/enterprise/federation/contacts/",
  "/enterprise/federation/directory/",
  "/enterprise/federation/identity",
  "/enterprise/federation/messages",
  "/enterprise/federation/messages/",
  "/enterprise/health",
  "/enterprise/invite",
  "/enterprise/join",
  "/enterprise/join/",
  "/enterprise/knowledge",
  "/enterprise/knowledge/",
  "/enterprise/legal",
  "/enterprise/local-agent",
  "/enterprise/local-agent/pair",
  "/enterprise/local-agent/pair/verify",
  "/enterprise/message-attachments",
  "/enterprise/message-attachments/",
  "/enterprise/messages",
  "/enterprise/messages/",
  "/enterprise/messages/unread",
  "/enterprise/model-gateway",
  "/enterprise/model-gateway/access-token",
  "/enterprise/modules/updates",
  "/enterprise/modules/updates/client",
  "/enterprise/offboard",
  "/enterprise/onboard",
  "/enterprise/organization",
  "/enterprise/organization/departments",
  "/enterprise/organization/departments/",
  "/enterprise/organization/features",
  "/enterprise/organization/invite",
  "/enterprise/organization/positions",
  "/enterprise/organization/positions/",
  "/enterprise/organization/sync",
  "/enterprise/organization/view",
  "/enterprise/organizations",
  "/enterprise/park",
  "/enterprise/park-",
  "/enterprise/park-admin",
  "/enterprise/park-meeting-rooms",
  "/enterprise/park-meeting-rooms/",
  "/enterprise/park-meeting-slots",
  "/enterprise/park-resources",
  "/enterprise/park-services",
  "/enterprise/park-services/announcement-results",
  "/enterprise/park-services/publications",
  "/enterprise/park-services/push",
  "/enterprise/park-services/survey-results",
  "/enterprise/park-settings",
  "/enterprise/park-statistics",
  "/enterprise/park-statistics/",
  "/enterprise/park-statistics/inbox",
  "/enterprise/park/",
  "/enterprise/park/invite",
  "/enterprise/park/join",
  "/enterprise/park/manage",
  "/enterprise/park/profile",
  "/enterprise/park/services",
  "/enterprise/park/services/assign",
  "/enterprise/park/services/request",
  "/enterprise/park/specialists",
  "/enterprise/park/statistics",
  "/enterprise/park/tenants",
  "/enterprise/park/view",
  "/enterprise/platform/organizations",
  "/enterprise/platform/organizations/",
  "/enterprise/presence/heartbeat",
  "/enterprise/privacy",
  "/enterprise/privacy/accept",
  "/enterprise/privacy/account",
  "/enterprise/privacy/export",
  "/enterprise/recall",
  "/enterprise/report",
  "/enterprise/sdk/otto-discovery.js",
  "/enterprise/skills",
  "/enterprise/skills/",
  "/enterprise/skills/leaderboard",
  "/enterprise/task",
  "/enterprise/tickets",
  "/enterprise/tickets/",
  "/enterprise/tickets/inbox",
  "/enterprise/usage",
  "/enterprise/usage/summary",
] as const;

const V1_9_13_STATIC_CAPABILITIES = [
  "password_auth",
  "sms_login",
  "sms_registration",
  "personal_registration",
  "personal_enterprise_upgrade",
  "organization_invites",
  "usage_summary",
  "admin_console",
  "account_deletion",
  "data_governance_v1",
  "privacy_self_service",
  "multi_organization",
  "direct_messages",
  "federation_chat_v1",
  "e2ee_private_messages_v1",
  "e2ee_device_trust_v1",
  "e2ee_mls_transport_v1",
  "e2ee_mls_resource_governance_v1",
  "e2ee_mls_transport_session_reset_v1",
  "direct_message_attachments_v1",
  "encrypted_attachment_storage_v1",
  "encrypted_message_storage_v1",
  "atoa",
  "position_invites",
  "park_service_push",
  "park_repair_v1",
  "park_services_v2",
  "organization_structure_v1",
  "organization_feature_switches_v1",
  "park_membership_v1",
  "park_specialist_routing_v1",
  "unread_message_notifications_v1",
  "account_presence_v1",
  "park_tenants_v1",
  "park_tenant_profiles_v1",
  "park_service_statistics_v1",
  "private_deployment_v1",
  "private_deployment_bootstrap_v1",
  "license_enforcement_v1",
  "encrypted_telemetry_queue_v1",
  "signed_telemetry_transport_v1",
  "diagnostic_bundle_v1",
  "data_protection_v1",
  "park_resources_v1",
  "park_meeting_slots_v1",
  "modular_update_push_v1",
  "signed_update_policy_v1",
  "managed_model_gateway_v1",
  "control_command_queue_v1",
  "account_data_sync_v1",
  "enterprise_skill_market_v1",
  "federation_gateway_v1",
] as const;

function collectProductionSources(directory: string): string {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && entry.name !== 'dist')
    .map((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectProductionSources(absolute);
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return '';
      return fs.readFileSync(absolute, 'utf8');
    })
    .join('\n');
}

describe('v1.9.13 enterprise compatibility contract', () => {
  it('keeps every frozen production /enterprise route literal reachable in current source', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const currentProductionSource = collectProductionSources(sourceRoot);
    const missing = V1_9_13_PRODUCTION_ROUTE_LITERALS.filter(
      (route) => !currentProductionSource.includes(route),
    );
    expect(missing).toEqual([]);
  });

  it('keeps current capabilities as a strict superset of v1.9.13', () => {
    const oldCapabilities = [
      ...V1_9_13_STATIC_CAPABILITIES,
      ...e2eeProductionCapabilities(),
    ];
    const current = new Set<string>(ENTERPRISE_CAPABILITIES);
    expect(oldCapabilities.filter((capability) => !current.has(capability))).toEqual([]);
    expect(current.has('customer_module_market_v1')).toBe(true);
  });

  it('preserves authentication and entitlement boundaries on the restored routes', () => {
    expect(isLicenseMaintenanceRoute('/enterprise/bootstrap/prepare', 'POST')).toBe(true);
    expect(isMemberRoute('/enterprise/model-gateway')).toBe(true);
    expect(isMemberRoute('/enterprise/model-gateway/access-token')).toBe(true);
    expect(commercialFeatureForEnterpriseRoute('/enterprise/model-gateway')).toBe(
      'model_gateway',
    );
    expect(
      commercialFeatureForEnterpriseRoute('/enterprise/model-gateway/access-token'),
    ).toBe('model_gateway');
  });
});
