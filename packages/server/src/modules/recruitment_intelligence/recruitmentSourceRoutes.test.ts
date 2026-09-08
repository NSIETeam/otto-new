import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { handleRecruitmentSourceRoute } from './recruitmentSourceRoutes.js';
import type { RecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';

function harness(overrides: Partial<Parameters<typeof handleRecruitmentSourceRoute>[0]> = {}) {
  const req = new EventEmitter() as Parameters<typeof handleRecruitmentSourceRoute>[0]['req'];
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    headersSent: false,
    setHeader: vi.fn(),
  }) as unknown as Parameters<typeof handleRecruitmentSourceRoute>[0]['res'];
  const sendJson = vi.fn();
  const runtime: RecruitmentSourceRuntime = {
    listSources: vi.fn(async () => [{
      id: 'official', label: '正式人才接口', accessMode: 'official_api',
      capabilities: ['search_candidates', 'get_candidate'],
      productionEnabled: true, authorized: true, searchable: true, status: 'ready',
      authorizationEvidenceRecorded: true,
    }]),
    search: vi.fn(async () => ({ runId: 'run-1', candidates: [], sources: [] })),
    getSearchRun: vi.fn(async () => null),
  };
  return {
    runtime,
    sendJson,
    input: {
      path: '/enterprise/recruitment/sources', method: 'GET', req, res,
      principal: { organizationId: 'org-a', accountId: 'admin-a', isAdmin: true },
      runtime,
      readBody: vi.fn(async () => ({})),
      sendJson,
      ...overrides,
    } satisfies Parameters<typeof handleRecruitmentSourceRoute>[0],
  };
}

describe('recruitment source HTTP routes', () => {
  it('does not return a snapshot cleared while the job permission check is pending', async () => {
    const h = harness({ path: '/enterprise/recruitment/source-runs/run-1', method: 'GET', authorizeJob: async () => true });
    vi.mocked(h.runtime.getSearchRun).mockResolvedValueOnce({
      runId: 'run-1', organizationId: 'org-a', actorAccountId: 'admin-a', requisitionId: 'job', query: 'private', createdAt: new Date().toISOString(), candidates: [], sources: [],
    }).mockResolvedValue(null);
    await handleRecruitmentSourceRoute(h.input);
    expect(h.sendJson).toHaveBeenLastCalledWith(h.input.res, 404, expect.objectContaining({ code: 'RECRUITMENT_RUN_NOT_FOUND' }));
  });
  it('scopes source readiness to the requested job and rechecks permission after asynchronous listing', async () => {
    const authorizeJob = vi.fn(async () => true);
    const h = harness({ authorizeJob });
    h.input.req.url = '/enterprise/recruitment/sources?requisitionId=job-1';
    await handleRecruitmentSourceRoute(h.input);
    expect(h.input.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(h.runtime.listSources).toHaveBeenCalledWith({ organizationId: 'org-a', actorAccountId: 'admin-a', requisitionId: 'job-1' });
    expect(authorizeJob).toHaveBeenCalledTimes(2);
    authorizeJob.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await handleRecruitmentSourceRoute(h.input);
    expect(h.sendJson).toHaveBeenLastCalledWith(h.input.res, 403, expect.anything());
  });
  it('rejects duplicate, invalid and unauthorized job readiness requests without listing sources', async () => {
    for (const query of ['requisitionId=job-1&requisitionId=job-2', 'requisitionId=', 'requisitionId=job-1']) {
      const h = harness({ authorizeJob: async () => false }); h.input.req.url = `/enterprise/recruitment/sources?${query}`;
      await handleRecruitmentSourceRoute(h.input);
      expect(h.runtime.listSources).not.toHaveBeenCalled();
      expect(h.sendJson.mock.calls[0]![1]).toBe(query === 'requisitionId=job-1' ? 403 : 400);
    }
  });
  it('allows assigned non-admin HR with a fresh job authorization check before and after search', async () => {
    const authorizeJob = vi.fn(async () => true);
    const h = harness({ path: '/enterprise/recruitment/sources/search', method: 'POST',
      principal: { organizationId: 'org-a', accountId: 'hr', isAdmin: false }, authorizeJob,
      readBody: vi.fn(async () => ({ requisitionId: 'job-1', query: 'React' })),
    });
    await handleRecruitmentSourceRoute(h.input);
    expect(authorizeJob).toHaveBeenCalledWith('hr', 'job-1');
    expect(authorizeJob).toHaveBeenCalledTimes(2);
    expect(h.sendJson).toHaveBeenLastCalledWith(h.input.res, 200, expect.anything());
    authorizeJob.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await handleRecruitmentSourceRoute(h.input);
    expect(h.sendJson).toHaveBeenLastCalledWith(h.input.res, 403, expect.anything());
  });
  it('rejects unassigned jobs before contacting sources and hides other users saved searches', async () => {
    const h = harness({ path: '/enterprise/recruitment/sources/search', method: 'POST',
      authorizeJob: vi.fn(async () => false), readBody: vi.fn(async () => ({ requisitionId: 'job-1', query: 'React' })),
    });
    await handleRecruitmentSourceRoute(h.input);
    expect(h.runtime.search).not.toHaveBeenCalled();
    const other = harness({ path: '/enterprise/recruitment/source-runs/run-1', method: 'GET' });
    vi.mocked(other.runtime.getSearchRun).mockResolvedValue({ runId: 'run-1', organizationId: 'org-a', actorAccountId: 'other', requisitionId: 'job-1', query: 'private', createdAt: '', candidates: [], sources: [] });
    await handleRecruitmentSourceRoute(other.input);
    expect(other.sendJson).toHaveBeenLastCalledWith(other.input.res, 404, expect.not.objectContaining({ result: expect.anything() }));
  });
  it('loads materials using authenticated scope and stored source references, not supplied URLs', async () => {
    const h = harness({
      path: '/enterprise/recruitment/sources/material', method: 'POST',
      readBody: vi.fn(async () => ({
        runId: 'run-1', requisitionId: 'job-1', canonicalId: 'candidate-1', sourceId: 'official',
        organizationId: 'attacker', actorAccountId: 'attacker', url: 'http://localhost/private',
      })),
    });
    h.runtime.getCandidateMaterial = vi.fn(async () => ({ material: { completeness: 'partial' } }) as never);
    await expect(handleRecruitmentSourceRoute(h.input)).resolves.toBe(true);
    expect(h.runtime.getCandidateMaterial).toHaveBeenCalledWith({
      organizationId: 'org-a', actorAccountId: 'admin-a', runId: 'run-1', requisitionId: 'job-1',
      canonicalId: 'candidate-1', sourceId: 'official', signal: expect.any(AbortSignal),
    });
    expect(h.sendJson).toHaveBeenCalledWith(h.input.res, 200, expect.objectContaining({ contract: 'otto-recruitment-material-v1' }));
  });

  it('does not load material for non-admins or older runtimes', async () => {
    const h = harness({ path: '/enterprise/recruitment/sources/material', method: 'POST' });
    await handleRecruitmentSourceRoute(h.input);
    expect(h.sendJson).toHaveBeenCalledWith(h.input.res, 409, expect.objectContaining({ code: 'RECRUITMENT_MATERIAL_UNSUPPORTED' }));
    const member = harness({
      path: '/enterprise/recruitment/sources/material', method: 'POST',
      principal: { organizationId: 'org-a', accountId: 'member-a', isAdmin: false },
    });
    await handleRecruitmentSourceRoute(member.input);
    expect(member.sendJson).toHaveBeenCalledWith(member.input.res, 403, expect.anything());
    expect(member.input.readBody).not.toHaveBeenCalled();
  });

  it('lists only the sanitized runtime view for an authenticated administrator', async () => {
    const h = harness();
    await expect(handleRecruitmentSourceRoute(h.input)).resolves.toBe(true);
    expect(h.runtime.listSources).toHaveBeenCalledWith({
      organizationId: 'org-a', actorAccountId: 'admin-a',
    });
    expect(h.sendJson).toHaveBeenCalledWith(h.input.res, 200, expect.objectContaining({
      contract: 'otto-recruitment-sources-v1', searchableSourceCount: 1,
    }));
  });

  it('fails closed when the runtime is absent or the member is not an administrator', async () => {
    const missing = harness({ runtime: undefined });
    await handleRecruitmentSourceRoute(missing.input);
    expect(missing.sendJson).toHaveBeenCalledWith(missing.input.res, 503, expect.objectContaining({
      code: 'RECRUITMENT_SOURCES_NOT_CONFIGURED',
    }));

    const member = harness({
      principal: { organizationId: 'org-a', accountId: 'member-a', isAdmin: false },
    });
    await handleRecruitmentSourceRoute(member.input);
    expect(member.runtime.listSources).not.toHaveBeenCalled();
    expect(member.sendJson).toHaveBeenCalledWith(member.input.res, 403, expect.objectContaining({
      code: 'RECRUITMENT_ADMIN_REQUIRED',
    }));
  });

  it('derives tenant and actor from the login session instead of request JSON', async () => {
    const h = harness({
      path: '/enterprise/recruitment/sources/search',
      method: 'POST',
      readBody: vi.fn(async () => ({
        organizationId: 'attacker-org', actorAccountId: 'attacker-account',
        requisitionId: 'frontend-1', query: 'Electron 前端',
        sourceIds: ['official'], limitPerSource: 20,
      })),
    });
    await handleRecruitmentSourceRoute(h.input);
    expect(h.runtime.search).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a', actorAccountId: 'admin-a',
      requisitionId: 'frontend-1', query: 'Electron 前端',
      sourceIds: ['official'], limitPerSource: 20,
    }));
    expect(h.sendJson).toHaveBeenCalledWith(h.input.res, 200, expect.objectContaining({
      contract: 'otto-recruitment-source-results-v1',
    }));
  });

  it('rejects invalid limits and does not invoke a connector', async () => {
    const h = harness({
      path: '/enterprise/recruitment/sources/search', method: 'POST',
      readBody: vi.fn(async () => ({
        requisitionId: 'frontend-1', query: '前端', limitPerSource: 50_000,
      })),
    });
    await handleRecruitmentSourceRoute(h.input);
    expect(h.runtime.search).not.toHaveBeenCalled();
    expect(h.sendJson).toHaveBeenCalledWith(h.input.res, 400, expect.objectContaining({
      code: 'RECRUITMENT_REQUEST_INVALID',
    }));
  });

  it('does not reflect an upstream connector error even when its text resembles validation', async () => {
    const h = harness({
      path: '/enterprise/recruitment/sources/search', method: 'POST',
      readBody: vi.fn(async () => ({
        requisitionId: 'frontend-1', query: '前端',
      })),
    });
    vi.mocked(h.runtime.search).mockRejectedValue(
      new Error('invalid oauth secret: upstream-sensitive-value'),
    );
    await handleRecruitmentSourceRoute(h.input);
    expect(h.sendJson).toHaveBeenCalledWith(h.input.res, 502, {
      error: 'recruitment source search failed',
      code: 'RECRUITMENT_SOURCE_FAILED',
    });
  });

  it('returns a tenant-scoped saved run and hides whether another tenant owns an id', async () => {
    const h = harness({
      path: '/enterprise/recruitment/source-runs/run-1', method: 'GET',
    });
    vi.mocked(h.runtime.getSearchRun).mockResolvedValue({
      runId: 'run-1', organizationId: 'org-a', actorAccountId: 'admin-a',
      requisitionId: 'frontend-1', query: '前端', createdAt: '2026-09-07T00:00:00.000Z',
      candidates: [], sources: [],
    });
    await handleRecruitmentSourceRoute(h.input);
    expect(h.runtime.getSearchRun).toHaveBeenCalledWith('org-a', 'run-1');
    expect(h.sendJson).toHaveBeenCalledWith(h.input.res, 200, expect.anything());

    vi.mocked(h.runtime.getSearchRun).mockResolvedValue(null);
    await handleRecruitmentSourceRoute(h.input);
    expect(h.sendJson).toHaveBeenLastCalledWith(h.input.res, 404, expect.objectContaining({
      code: 'RECRUITMENT_RUN_NOT_FOUND',
    }));
  });

  it('ignores unrelated paths', async () => {
    const h = harness({ path: '/enterprise/tickets' });
    await expect(handleRecruitmentSourceRoute(h.input)).resolves.toBe(false);
    expect(h.sendJson).not.toHaveBeenCalled();
  });
});
