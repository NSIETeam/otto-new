/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { OrganizationFeatureKey } from '../../productModules.js';

interface CommercialRouteRule {
  feature: OrganizationFeatureKey;
  matches(path: string): boolean;
}

export interface CommercialRouteContext {
  ticketServiceId?: string;
  crossOrganizationView?: boolean;
  method?: string;
}

const prefix = (value: string) => (path: string): boolean =>
  path === value || path.startsWith(`${value}/`);

const BASELINE_COLLABORATION_ROUTES: ReadonlyArray<
  (path: string) => boolean
> = [
  prefix('/enterprise/messages'),
  prefix('/enterprise/message-attachments'),
  prefix('/enterprise/attachments'),
  prefix('/enterprise/e2ee'),
  prefix('/enterprise/presence/heartbeat'),
] as const;

/**
 * Same-organization messaging is part of the authenticated Otto baseline.
 * The organization switch still controls availability, while Federation and
 * A2A remain separately licensed commercial capabilities.
 */
export function baselineOrganizationFeatureForEnterpriseRoute(
  path: string,
): OrganizationFeatureKey | null {
  return BASELINE_COLLABORATION_ROUTES.some((matches) => matches(path))
    ? 'direct_messages'
    : null;
}

/**
 * Maps externally callable enterprise routes to the signed License capability
 * required before the request reaches a business handler.
 *
 * Authentication, License maintenance, diagnostics, backup and privacy export
 * routes are deliberately absent so an expired customer can recover access and
 * export its data.
 */
const COMMERCIAL_ROUTE_RULES: readonly CommercialRouteRule[] = [
  {
    feature: 'model_gateway',
    matches: prefix('/enterprise/model-gateway'),
  },
  { feature: 'atoa', matches: prefix('/enterprise/federation/a2a') },
  { feature: 'direct_messages', matches: prefix('/enterprise/federation') },
  { feature: 'atoa', matches: prefix('/enterprise/atoa') },
  { feature: 'direct_messages', matches: prefix('/enterprise/messages') },
  { feature: 'direct_messages', matches: prefix('/enterprise/message-attachments') },
  { feature: 'direct_messages', matches: prefix('/enterprise/attachments') },
  { feature: 'direct_messages', matches: prefix('/enterprise/e2ee') },
  { feature: 'direct_messages', matches: prefix('/enterprise/presence/heartbeat') },
  { feature: 'park_service', matches: prefix('/enterprise/park') },
  { feature: 'park_service', matches: (path) => path.startsWith('/enterprise/park-') },
  { feature: 'park_service', matches: prefix('/enterprise/park-services') },
  { feature: 'park_service', matches: prefix('/enterprise/park-resources') },
  { feature: 'park_service', matches: prefix('/enterprise/park-statistics') },
  { feature: 'skill_market', matches: prefix('/enterprise/skills') },
  { feature: 'knowledge', matches: prefix('/enterprise/knowledge') },
  { feature: 'enterprise_tree', matches: prefix('/enterprise/organization') },
  { feature: 'enterprise_tree', matches: prefix('/enterprise/organizations') },
  { feature: 'enterprise_tree', matches: prefix('/enterprise/accounts') },
  { feature: 'enterprise_tree', matches: prefix('/enterprise/platform/organizations') },
] as const;

export function commercialFeatureForEnterpriseRoute(
  path: string,
  context: CommercialRouteContext = {},
): OrganizationFeatureKey | null {
  // A signed deployment always exposes each member's own directory. Editing
  // structure or reading another organization remains a paid capability.
  if (
    (path === '/enterprise/organization/view' ||
      path === '/enterprise/organization/sync') &&
    !context.crossOrganizationView
  ) {
    return null;
  }
  if (
    path === '/enterprise/organization/features' &&
    (context.method ?? 'GET').toUpperCase() === 'GET'
  ) {
    return null;
  }
  if (baselineOrganizationFeatureForEnterpriseRoute(path)) {
    return null;
  }
  if (path === '/enterprise/tickets') {
    return context.ticketServiceId && context.ticketServiceId !== 'it'
      ? 'park_service'
      : null;
  }
  return COMMERCIAL_ROUTE_RULES.find((rule) => rule.matches(path))?.feature ?? null;
}
