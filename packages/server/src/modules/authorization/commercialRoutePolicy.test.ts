/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { commercialFeatureForEnterpriseRoute } from './commercialRoutePolicy.js';

describe('commercial enterprise route policy', () => {
  it.each([
    ['/enterprise/atoa/inbox', 'atoa'],
    ['/enterprise/park/services/request', 'park_service'],
    ['/enterprise/park-statistics/inbox', 'park_service'],
    ['/enterprise/park-settings', 'park_service'],
    ['/enterprise/park-meeting-rooms', 'park_service'],
    ['/enterprise/park-meeting-slots', 'park_service'],
    ['/enterprise/organization/public-profile', 'park_service'],
    ['/enterprise/skills/leaderboard', 'skill_market'],
    ['/enterprise/customer-modules/com.acme.report/1.0.0/install', 'skill_market'],
    ['/enterprise/platform/customer-modules/com.acme.report/1.0.0/review', 'skill_market'],
    ['/enterprise/knowledge/revisions', 'knowledge'],
    ['/enterprise/organization/departments', 'enterprise_tree'],
    ['/enterprise/platform/organizations/org-a', 'enterprise_tree'],
  ] as const)('maps %s to %s', (path, feature) => {
    expect(commercialFeatureForEnterpriseRoute(path)).toBe(feature);
  });

  it.each([
    '/enterprise/auth/login',
    '/enterprise/deployment/license',
    '/enterprise/deployment/license/lease',
    '/enterprise/deployment/diagnostics',
    '/enterprise/deployment/data-protection/backup',
    '/enterprise/export',
    '/enterprise/privacy/export',
    '/enterprise/modules/updates',
  ])('keeps recovery route %s outside module gates', (path) => {
    expect(commercialFeatureForEnterpriseRoute(path)).toBeNull();
  });

  it('leaves mixed internal and park tickets to record-level policy', () => {
    expect(commercialFeatureForEnterpriseRoute(
      '/enterprise/tickets',
      { ticketServiceId: 'repair' },
    )).toBe('park_service');
    expect(commercialFeatureForEnterpriseRoute(
      '/enterprise/tickets',
      { ticketServiceId: 'it' },
    )).toBeNull();
    expect(commercialFeatureForEnterpriseRoute('/enterprise/tickets')).toBeNull();
    expect(
      commercialFeatureForEnterpriseRoute('/enterprise/tickets/ticket-1/action'),
    ).toBeNull();
  });

  it('keeps the current organization directory available as a baseline capability', () => {
    expect(
      commercialFeatureForEnterpriseRoute('/enterprise/organization/view'),
    ).toBeNull();
    expect(
      commercialFeatureForEnterpriseRoute('/enterprise/organization/sync'),
    ).toBeNull();
    expect(
      commercialFeatureForEnterpriseRoute('/enterprise/organization/view', {
        crossOrganizationView: true,
      }),
    ).toBe('enterprise_tree');
    expect(
      commercialFeatureForEnterpriseRoute('/enterprise/organization/departments'),
    ).toBe('enterprise_tree');
    expect(
      commercialFeatureForEnterpriseRoute('/enterprise/organization/features', {
        method: 'GET',
      }),
    ).toBeNull();
    expect(
      commercialFeatureForEnterpriseRoute('/enterprise/organization/features', {
        method: 'PATCH',
      }),
    ).toBeNull();
  });

  it.each([
    ['/enterprise/accounts', 'GET'],
    ['/enterprise/accounts', 'POST'],
    ['/enterprise/accounts/account-1', 'PATCH'],
    ['/enterprise/accounts/account-1', 'DELETE'],
    ['/enterprise/organization/invite', 'GET'],
    ['/enterprise/organization/invite', 'POST'],
  ] as const)(
    'keeps same-organization member administration %s %s in the enterprise baseline',
    (path, method) => {
      expect(commercialFeatureForEnterpriseRoute(path, { method })).toBeNull();
    },
  );

  it.each([
    '/enterprise/messages/unread',
    '/enterprise/messages/account-1',
    '/enterprise/message-attachments/file-1',
    '/enterprise/attachments/inline',
    '/enterprise/e2ee/devices',
    '/enterprise/e2ee/mls/key-packages',
    '/enterprise/presence/heartbeat',
  ])('keeps same-organization collaboration route %s outside module entitlements', (path) => {
    expect(commercialFeatureForEnterpriseRoute(path)).toBeNull();
  });

  it('separates A2A federation grants from direct-message federation routes', () => {
    expect(commercialFeatureForEnterpriseRoute(
      '/enterprise/federation/a2a/grants/grant-1/consume',
    )).toBe('atoa');
    expect(commercialFeatureForEnterpriseRoute(
      '/enterprise/federation/messages/pull',
    )).toBe('direct_messages');
  });

  it('does not match similar unowned path prefixes', () => {
    expect(commercialFeatureForEnterpriseRoute('/enterprise/parking-lot')).toBeNull();
    expect(commercialFeatureForEnterpriseRoute('/enterprise/messaging')).toBeNull();
  });
});
