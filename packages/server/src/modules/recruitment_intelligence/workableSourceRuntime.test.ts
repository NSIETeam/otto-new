import { expect, it, vi } from 'vitest';
import { createWorkableSourceRuntime } from './workableSourceRuntime.js';
import { MemoryRecruitmentSourceStore } from './recruitmentSourceStore.js';
import type { WorkableOAuthGrant } from './workableMcpSession.js';

const scope = { organizationId: 'org', actorAccountId: 'hr', requisitionId: 'job' };
const grant: WorkableOAuthGrant = { ...scope, account: 'acme', jobShortcode: 'FRONT', bindingRevision: 'rev', accessToken: 'private-token', expiresAt: '2099-01-01T00:00:00Z' };
function fixture(env: NodeJS.ProcessEnv = {}) {
  const resolveGrant = vi.fn(async (input): Promise<WorkableOAuthGrant | null> => input.requisitionId === 'job' ? grant : null);
  const fetchMock = vi.fn<typeof fetch>();
  const store = new MemoryRecruitmentSourceStore();
  const runtime = createWorkableSourceRuntime({ connectionService: () => ({ resolveGrant }), store, env, fetch: fetchMock, audit: async () => undefined, auditMaterial: async () => undefined });
  return { runtime, resolveGrant, fetchMock };
}
it('registers the built-in connector without enabling real data or making network requests', async () => {
  const f = fixture({ OTTO_WORKABLE_OAUTH_ENABLED: '1' });
  expect(await f.runtime.listSources(scope)).toMatchObject([{ id: 'workable', searchable: false, status: 'production_approval_required' }]);
  await f.runtime.search({ ...scope, query: 'React' });
  expect(f.resolveGrant).not.toHaveBeenCalled();
  expect(f.fetchMock).not.toHaveBeenCalled();
});
it('requires both deployment acceptance and a current personal job-scoped grant', async () => {
  const f = fixture({ OTTO_WORKABLE_REAL_ACCOUNT_VERIFIED: '1', OTTO_WORKABLE_AUTHORIZATION_REFERENCE: 'acceptance-123' });
  expect(await f.runtime.listSources({ organizationId: 'org', actorAccountId: 'hr' })).toMatchObject([{ searchable: false, reason: expect.stringContaining('岗位') }]);
  expect(await f.runtime.listSources({ ...scope, requisitionId: 'other' })).toMatchObject([{ searchable: false }]);
  expect(await f.runtime.listSources(scope)).toMatchObject([{ searchable: true }]);
  expect(f.resolveGrant).toHaveBeenLastCalledWith(scope, expect.any(AbortSignal));
  f.resolveGrant.mockResolvedValue(null);
  expect(await f.runtime.listSources(scope)).toMatchObject([{ searchable: false }]);
  expect(f.fetchMock).not.toHaveBeenCalled();
});
it('passes the selected job through the search authorization gate, without borrowing another job grant', async () => {
  const f = fixture({ OTTO_WORKABLE_REAL_ACCOUNT_VERIFIED: '1', OTTO_WORKABLE_AUTHORIZATION_REFERENCE: 'acceptance-123' });
  const result = await f.runtime.search({ ...scope, requisitionId: 'other', query: 'React' });
  expect(result.sources).toMatchObject([{ status: 'unauthorized' }]);
  expect(f.resolveGrant).toHaveBeenCalledWith({ ...scope, requisitionId: 'other' }, expect.any(AbortSignal));
  expect(f.fetchMock).not.toHaveBeenCalled();
});
it.each(['', ' ', undefined])('never enables data access with a missing acceptance reference (%s)', async (reference) => {
  const f = fixture({ OTTO_WORKABLE_REAL_ACCOUNT_VERIFIED: '1', OTTO_WORKABLE_AUTHORIZATION_REFERENCE: reference });
  expect(await f.runtime.listSources(scope)).toMatchObject([{ searchable: false }]);
});
it.each(['not-json', '[]', '["http://files.example"]', '["https://*.example"]', '["https://files.example/resume"]', '["https://user:secret@files.example"]'])('fails closed for unreviewable resume origin configuration: %s', (origins) => {
  expect(() => fixture({ OTTO_WORKABLE_RESUME_ORIGINS: origins })).toThrow();
});
