import { describe, expect, it } from 'vitest';
import { isAdminRoute, isMemberRoute, isLicenseMaintenanceRoute } from './enterpriseRoutePolicy.js';

it('supplies authenticated membership to startup carpool requests without matching unrelated prefixes', () => {
  for (const route of ['/enterprise/park-carpool', '/enterprise/park-carpool/workflow']) expect(isMemberRoute(route)).toBe(true);
  expect(isMemberRoute('/enterprise/park-carpooling')).toBe(false);
});

describe('customer module route authorization', () => {
  it('keeps authoring and installation on member sessions', () => {
    expect(isMemberRoute('/enterprise/customer-modules')).toBe(true);
    expect(isMemberRoute('/enterprise/customer-modules/com.acme.report/1.0.0/install')).toBe(true);
    expect(isAdminRoute('/enterprise/customer-modules/com.acme.report/1.0.0/install')).toBe(false);
  });

  it('reserves public-market review and suspension for platform administration', () => {
    const review = '/enterprise/platform/customer-modules/com.acme.report/1.0.0/review';
    expect(isAdminRoute(review)).toBe(true);
    expect(isMemberRoute(review)).toBe(false);
  });
});

describe('enterprise public profile and partnership route authorization', () => {
  it('allows signed-in members to read public profile and star-map routes', () => {
    expect(isMemberRoute('/enterprise/organization/public-profile')).toBe(true);
    expect(isMemberRoute('/enterprise/park/star-map')).toBe(true);
    expect(isAdminRoute('/enterprise/organization/public-profile')).toBe(false);
    expect(isAdminRoute('/enterprise/park/star-map')).toBe(false);
  });
});

describe('recruitment source route authorization', () => {
  it('keeps source discovery and searches behind signed-in member routing', () => {
    expect(isMemberRoute('/enterprise/recruitment/sources')).toBe(true);
    expect(isMemberRoute('/enterprise/recruitment/workable')).toBe(true);
    expect(isAdminRoute('/enterprise/recruitment/workable')).toBe(false);
    expect(isLicenseMaintenanceRoute('/enterprise/recruitment/workable', 'POST')).toBe(true);
    expect(isLicenseMaintenanceRoute('/enterprise/recruitment/sources/material', 'POST')).toBe(false);
    expect(isMemberRoute('/enterprise/recruitment/sources/search')).toBe(true);
    expect(isMemberRoute('/enterprise/recruitment/sources/material')).toBe(true);
    expect(isMemberRoute('/enterprise/recruitment/source-runs/run_123')).toBe(true);
    expect(isAdminRoute('/enterprise/recruitment/sources')).toBe(false);
  });

  it('does not authorize lookalike route prefixes', () => {
    expect(isMemberRoute('/enterprise/recruitment/sources-evil')).toBe(false);
    expect(isMemberRoute('/enterprise/recruitment/workable-evil')).toBe(false);
    expect(isMemberRoute('/enterprise/recruitment/sources/material-evil')).toBe(false);
    expect(isMemberRoute('/enterprise/recruitment/source-runs-evil/run_123')).toBe(false);
  });
});

it('authenticates every market route as an account before market-scoped authorization', () => {
  for (const path of ['/enterprise/park-market','/enterprise/park-market/settings/P','/enterprise/park-market/listings/L/contact','/enterprise/park-market/mine']) expect(isMemberRoute(path)).toBe(true);
  expect(isMemberRoute('/enterprise/park-marketplace')).toBe(false);
});
