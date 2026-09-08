import { describe, it, expect, vi } from 'vitest';
import {
  handleClusteredBusinessRoute,
  type ClusteredBusinessRouteInput,
} from './clusteredBusinessRoutes.js';
function fixture() {
  const records = new Map<string, any>();
  const record = (
    org: string,
    type: string,
    id: string,
    payload: any,
    status = 'active',
  ) => {
    const r = {
      organizationId: org,
      resourceType: type,
      resourceId: id,
      domain: 'park',
      status,
      payload,
      version: 1,
      updatedAt: '2026-09-08',
    };
    records.set(`${org}:${type}:${id}`, r);
    return r;
  };
  record('operator', 'park', 'park_operator', {
    name: '园区',
    adminOrganizationId: 'operator',
  });
  for (const id of ['a', 'b', 'private', 'unconfirmed']) {
    record(id, 'membership', `membership_${id}`, {
      parkId: 'park_operator',
      adminOrganizationId: 'operator',
    });
    record(id, 'public_profile', `public_profile_${id}`, {
      summary: '企业',
      website: '',
      industryTags: ['同标签'],
      productsServices: ['产品'],
      capabilities: [],
      cooperationNeeds: [],
      publicContact: '',
      isPublic: id !== 'private',
      primaryIndustryCode: 'it_services',
      industryConfirmedByCompany: id !== 'unconfirmed',
    });
  }
  record('other', 'membership', 'membership_other', {
    parkId: 'other_park',
    adminOrganizationId: 'operator',
  });
  record('other', 'public_profile', 'public_profile_other', {
    ...records.get('a:public_profile:public_profile_a').payload,
  });
  const repository = {
    getOrganizationFeatures: vi.fn(async () => ({ park_services: true })),
    getOrganization: vi.fn(async (id: string) => ({
      id,
      name: id,
      status: 'active',
    })),
    getBusinessRecord: vi.fn(
      async (q: any) =>
        records.get(`${q.organizationId}:${q.resourceType}:${q.resourceId}`) ??
        null,
    ),
    listParkTenantMemberships: vi.fn(async () =>
      [...records.values()].filter((r) => r.resourceType === 'membership'),
    ),
    updateBusinessRecord: vi.fn(async (q: any) =>
      record(
        q.organizationId,
        q.resourceType,
        q.resourceId,
        q.payload,
        q.status,
      ),
    ),
    appendBusinessEvent: vi.fn(async () => ({ inserted: true })),
  };
  const run = async (
    path = '/enterprise/park/star-map',
    method = 'GET',
    body: any = {},
    isAdmin = true,
  ) => {
    let result: any;
    await handleClusteredBusinessRoute({
      path,
      method,
      url: new URL('https://local' + path),
      req: {} as any,
      res: {} as any,
      member: {
        id: 'admin',
        organizationId: 'a',
        isAdmin,
        status: 'active',
      } as any,
      repository: repository as any,
      readBody: async () => body,
      sendJson: (_res, status, data) => {
        result = { status, data };
      },
      requireCommercialFeature: async () => true,
      commercialFeatureAvailable: async () => true,
    } as ClusteredBusinessRouteInput);
    return result;
  };
  return { records, repository, run };
}
describe('clustered enterprise star-map contract', () => {
  it('returns only same-park public companies and confirmed industry groups', async () => {
    const { run } = fixture();
    const { status, data } = await run();
    expect(status).toBe(200);
    expect(data.starMap.nodes.map((n: any) => n.organizationId).sort()).toEqual(
      ['a', 'b', 'unconfirmed'],
    );
    expect(data.starMap.industryGroups[0].memberOrganizationIds).toEqual([
      'a',
      'b',
    ]);
    expect(data.starMap.relationshipCount).toBe(1);
    expect(data.starMap.edges).toEqual([]);
  });
  it('confirms only administrator-selected standard industry, rejects unknown codes, and preserves legacy updates', async () => {
    const { run, records } = fixture();
    const body = records.get('a:public_profile:public_profile_a').payload;
    expect(
      (
        await run('/enterprise/organization/public-profile', 'PUT', {
          ...body,
          primaryIndustryCode: 'invented',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await run(
          '/enterprise/organization/public-profile',
          'PUT',
          { ...body, primaryIndustryCode: 'medical_devices' },
          false,
        )
      ).status,
    ).toBe(403);
    const result = await run('/enterprise/organization/public-profile', 'PUT', {
      ...body,
      primaryIndustryCode: 'medical_devices',
      primaryIndustryName: 'spoofed',
      isPublic: false,
    });
    expect(result.data.profile).toMatchObject({
      primaryIndustryName: '医疗器械',
      industryConfirmedByCompany: true,
      isPublic: false,
    });
    const { primaryIndustryCode: _code, ...legacy } = result.data.profile;
    expect(
      (await run('/enterprise/organization/public-profile', 'PUT', legacy)).data
        .profile.primaryIndustryCode,
    ).toBe('medical_devices');
  });
  it('removes withdrawn public profiles on the next request', async () => {
    const { run, records } = fixture();
    records.get('b:public_profile:public_profile_b').payload.isPublic = false;
    const result = await run();
    expect(result.data.starMap.relationshipCount).toBe(0);
    expect(
      result.data.starMap.nodes.map((n: any) => n.organizationId),
    ).not.toContain('b');
  });
  it('does not return a disabled park', async () => {
    const { run, records } = fixture();
    records.get('operator:park:park_operator').status = 'disabled';
    expect((await run()).status).not.toBe(200);
  });
});
