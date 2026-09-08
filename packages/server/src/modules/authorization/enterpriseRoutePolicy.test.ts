import { describe, expect, it } from 'vitest';
import { isAdminRoute, isMemberRoute } from './enterpriseRoutePolicy.js';

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

it('authenticates every market route as an account before market-scoped authorization', () => {
  for (const path of ['/enterprise/park-market','/enterprise/park-market/settings/P','/enterprise/park-market/listings/L/contact','/enterprise/park-market/mine']) expect(isMemberRoute(path)).toBe(true);
  expect(isMemberRoute('/enterprise/park-marketplace')).toBe(false);
});
