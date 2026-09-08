import { describe, expect, it, vi } from 'vitest';

import type { RecruitmentSourceAdapter } from './recruitmentSourceGateway.js';
import { createRecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';
import { MemoryRecruitmentSourceStore } from './recruitmentSourceStore.js';

it('starts a new interactive search at the first page instead of consuming a different job cursor', async () => {
  const store = new MemoryRecruitmentSourceStore();
  await store.setCursor({ organizationId: 'org-a', sourceId: 'official', cursor: 'other-job-page-7', updatedAt: new Date().toISOString() });
  const source = adapter('official');
  source.search = vi.fn(async () => ({ candidates: [] }));
  const runtime = createRecruitmentSourceRuntime({
    store, registrations: [{ adapter: source, accessMode: 'official_api', productionEnabled: true, authorizationReference: 'review' }],
    authorizeSource: async () => ({ allowed: true }),
  });
  await runtime.search({ organizationId: 'org-a', actorAccountId: 'hr-a', requisitionId: 'new-job', query: 'React' });
  expect(source.search).toHaveBeenCalledWith(expect.objectContaining({ cursor: '' }), expect.anything());
});

function adapter(id: string): RecruitmentSourceAdapter {
  return {
    id,
    label: id === 'official' ? '正式人才接口' : '开源浏览器实验连接器',
    capabilities: ['search_candidates', 'get_candidate'],
    search: vi.fn(async () => ({
      candidates: [{ sourceRecordId: `${id}-1`, displayName: '候选人 A' }],
    })),
  };
}

describe('recruitment source runtime', () => {
  it('does not promote a public GitHub connector into production without authorization evidence', async () => {
    const experimental = adapter('experimental');
    const runtime = createRecruitmentSourceRuntime({
      registrations: [{
        adapter: experimental,
        accessMode: 'evaluation_only',
        productionEnabled: false,
        repositoryUrl: 'https://github.com/example/recruitment-browser-automation',
      }],
      authorizeSource: async () => ({ allowed: true }),
    });

    const [source] = await runtime.listSources({
      organizationId: 'org-a',
      actorAccountId: 'admin-a',
    });
    expect(source).toMatchObject({
      status: 'production_approval_required',
      searchable: false,
      authorizationEvidenceRecorded: false,
    });
    const result = await runtime.search({
      organizationId: 'org-a', actorAccountId: 'admin-a',
      requisitionId: 'frontend-1', query: 'Electron 前端',
      sourceIds: ['experimental'],
    });
    expect(result.sources[0]).toMatchObject({ status: 'unauthorized' });
    expect(experimental.search).not.toHaveBeenCalled();
  });

  it('runs and persists only a production-approved, organization-authorized source', async () => {
    const official = adapter('official');
    const authorizeSource = vi.fn(async () => ({ allowed: true }));
    const runtime = createRecruitmentSourceRuntime({
      registrations: [{
        adapter: official,
        accessMode: 'official_api',
        productionEnabled: true,
        authorizationReference: 'contract-on-file',
      }],
      authorizeSource,
      createId: () => 'run-1',
      now: () => new Date('2026-09-07T00:00:00.000Z'),
    });

    const [source] = await runtime.listSources({
      organizationId: 'org-a', actorAccountId: 'admin-a',
    });
    expect(source).toMatchObject({ status: 'ready', searchable: true });
    const result = await runtime.search({
      organizationId: 'org-a', actorAccountId: 'admin-a',
      requisitionId: 'frontend-1', query: 'Electron 前端',
      sourceIds: ['official'],
    });
    expect(result).toMatchObject({ runId: 'run-1', candidates: [{ sourceCount: 1 }] });
    await expect(runtime.getSearchRun('org-a', 'run-1')).resolves.toMatchObject({
      organizationId: 'org-a', actorAccountId: 'admin-a', requisitionId: 'frontend-1',
    });
  });

  it('rejects unsafe repository links from the public view', async () => {
    const runtime = createRecruitmentSourceRuntime({
      registrations: [{
        adapter: adapter('official'),
        accessMode: 'authorized_mcp',
        productionEnabled: true,
        authorizationReference: 'review-1',
        repositoryUrl: 'file:///private/connector',
      }],
      authorizeSource: async () => ({ allowed: true }),
    });
    const [source] = await runtime.listSources({
      organizationId: 'org-a', actorAccountId: 'admin-a',
    });
    expect(source?.repositoryUrl).toBeUndefined();
  });

  it('isolates organization authorization failures without exposing connector details', async () => {
    const runtime = createRecruitmentSourceRuntime({
      registrations: [{
        adapter: adapter('official'),
        accessMode: 'official_api',
        productionEnabled: true,
        authorizationReference: 'contract-on-file',
      }],
      authorizeSource: async () => {
        throw new Error('oauth secret invalid: should never reach the client');
      },
    });
    const [source] = await runtime.listSources({
      organizationId: 'org-a', actorAccountId: 'admin-a',
    });
    expect(source).toMatchObject({
      authorized: false,
      searchable: false,
      status: 'organization_authorization_required',
      reason: '暂时无法验证该企业的来源授权，请稍后重试',
    });
    expect(JSON.stringify(source)).not.toContain('oauth secret');
  });

  it('does not mark an authorized but incomplete connector as searchable', async () => {
    const incomplete = adapter('official');
    incomplete.capabilities = ['search_candidates'];
    const runtime = createRecruitmentSourceRuntime({
      registrations: [{
        adapter: incomplete,
        accessMode: 'official_api',
        productionEnabled: true,
        authorizationReference: 'contract-on-file',
      }],
      authorizeSource: async () => ({ allowed: true }),
    });
    const [source] = await runtime.listSources({
      organizationId: 'org-a', actorAccountId: 'admin-a',
    });
    expect(source).toMatchObject({
      authorized: true,
      searchable: false,
      status: 'connector_capability_required',
    });
    expect(source?.reason).toContain('get_candidate');
  });
});
