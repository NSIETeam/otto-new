import { beforeEach, expect, it, vi } from 'vitest';
import { WorkableConnectionService } from './workableConnections.js';
import { createWorkableMcpSessionFactory } from './workableMcpSession.js';
import type { WorkableConnectionRecord, WorkableConnectionStore } from './workableConnectionStore.js';
import type { RecruitmentJobActor, RecruitmentSharedJob } from './recruitmentJobs.js';

const actors = new Map<string, RecruitmentJobActor>();
const records = new Map<string, WorkableConnectionRecord>();
const jobs = new Map<string, RecruitmentSharedJob>();
const key = (org: string, actor: string) => JSON.stringify([org, actor]);
const store: WorkableConnectionStore = {
  get: async (org, actor) => structuredClone(records.get(key(org, actor)) ?? null),
  compareAndSet: async (org, actor, revision, next) => {
    if ((records.get(key(org, actor))?.revision ?? 0) !== revision) return false;
    records.set(key(org, actor), structuredClone(next)); return true;
  },
};
const audit = vi.fn(async () => undefined);
const grant = { accessToken: 'secret-token', expiresAt: '2099-01-01T00:00:00Z', targets: [{ account: 'acme', shortcode: 'FRONT', label: '前端工程师' }] };
const scope = { organizationId: 'org', actorAccountId: 'hr', requisitionId: 'job' };
const options = { store, getActor: async (id: string) => actors.get(id) ?? null, getJob: async (org: string, id: string) => org === 'org' ? jobs.get(id) ?? null : null, audit };
const create = () => new WorkableConnectionService(options);
function acceptanceFixture() {
  const env = { OTTO_WORKABLE_ACCEPTANCE_SCOPES: JSON.stringify([{ ...scope, jobId: 'job', approvalReference: 'synthetic-test-only', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }]) };
  const probeFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [
        { name: 'get_accounts', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_candidates', inputSchema: { type: 'object', properties: { account: { type: 'string' }, shortcode: { type: 'string' }, limit: { type: 'integer' } }, required: ['account', 'shortcode'] } },
        { name: 'get_candidate', inputSchema: { type: 'object', properties: { account: { type: 'string' }, id: { type: 'string' } }, required: ['account', 'id'] } },
      ] } : body.params.name === 'get_accounts' ? { accounts: [{ subdomain: 'acme' }] }
        : body.params.name === 'get_candidates' ? { candidates: [{ id: '1', name: '私人姓名' }] }
          : { candidate: { id: '1', name: '私人姓名', headline: 'React 软件工程师' } };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });
  return { env, probeFetch, service: new WorkableConnectionService({ ...options, probeFetch, acceptanceEnv: env }) };
}
it('keeps one-sample verification separate from production, persists only proof metadata and invalidates it on rebind', async () => {
  const h = acceptanceFixture(); await connect(h.service);
  expect((await h.service.act('hr', { kind: 'status', jobId: 'job' })).materialAcceptanceAvailable).toBe(true);
  const result = await h.service.act('hr', { kind: 'material_probe', jobId: 'job', expectedRevision: 2, confirmed: true });
  expect(result.materialCheck).toMatchObject({ status: 'partial', candidatesRead: 1, modelInvoked: false, productionAccepted: false });
  expect(result.revision).toBe(3); expect(JSON.stringify(result)).not.toMatch(/secret-token|私人姓名|React 软件工程师/u);
  expect((await h.service.act('hr', { kind: 'status', jobId: 'job' })).materialCheck).toEqual(result.materialCheck);
  expect(h.probeFetch.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).params?.name === 'get_candidates')).toHaveLength(1);
  await h.service.act('hr', { kind: 'bind', jobId: 'job', expectedRevision: 3, account: 'acme', shortcode: 'FRONT', confirmed: true });
  expect((await h.service.act('hr', { kind: 'status', jobId: 'job' })).materialCheck).toBeUndefined();
});
it('refuses sample reads without separate confirmation, exact approval, or unchanged authority', async () => {
  const h = acceptanceFixture(); await connect(h.service);
  const action = { kind: 'material_probe' as const, jobId: 'job', expectedRevision: 2, confirmed: true as const };
  await expect(h.service.act('hr', { ...action, confirmed: false } as never)).rejects.toThrow();
  h.env.OTTO_WORKABLE_ACCEPTANCE_SCOPES = '[]'; await expect(h.service.act('hr', action)).rejects.toMatchObject({ status: 403 });
  expect(h.probeFetch).not.toHaveBeenCalled();
  const allowed = acceptanceFixture();
  allowed.probeFetch.mockImplementationOnce(async () => { records.get(key('org', 'hr'))!.grant = null; throw new Error('secret-token private upstream'); });
  await expect(allowed.service.act('hr', action)).rejects.toThrow('验收读取未完成');
  expect(records.get(key('org', 'hr'))?.materialAcceptance).toBeUndefined();
  expect(JSON.stringify(audit.mock.calls)).not.toMatch(/secret-token|私人姓名/u);
});
it('requires confirmation and the captured job revision for connection checks before any network read', async () => {
  const probeFetch = vi.fn<typeof fetch>();
  const service = await connect(new WorkableConnectionService({ ...options, probeFetch }));
  for (const patch of [{ confirmed: false }, { expectedRevision: 1 }, { jobId: 'missing' }]) {
    await expect(service.act('hr', { kind: 'probe', jobId: 'job', expectedRevision: 2, confirmed: true, ...patch } as never)).rejects.toThrow();
  }
  expect(probeFetch).not.toHaveBeenCalled();
});
it('does not check a newly rebound account when the confirmed binding changes during audit', async () => {
  const probeFetch = vi.fn<typeof fetch>();
  await connect();
  const service = new WorkableConnectionService({ ...options, probeFetch, audit: async (event) => {
    if (event.kind === 'probe') records.get(key('org', 'hr'))!.bindings[0]!.revision = 'changed';
  } });
  await expect(service.act('hr', { kind: 'probe', jobId: 'job', expectedRevision: 2, confirmed: true })).rejects.toThrow(/检查未通过/);
  expect(probeFetch).not.toHaveBeenCalled();
});
it('limits overlapping checks, rejects revoked in-flight checks, and releases the lock after failure', async () => {
  let release!: (value: Response) => void;
  let started!: () => void;
  const reached = new Promise<void>((resolve) => { started = resolve; });
  const probeFetch = vi.fn<typeof fetch>(async () => { started(); return new Promise<Response>((resolve) => { release = resolve; }); });
  const service = await connect(new WorkableConnectionService({ ...options, probeFetch }));
  const action = { kind: 'probe' as const, jobId: 'job', expectedRevision: 2, confirmed: true as const };
  const first = service.act('hr', action); const rejected = expect(first).rejects.toThrow(/检查未通过/);
  await reached;
  await expect(service.act('hr', action)).rejects.toMatchObject({ status: 429 });
  await service.act('hr', { kind: 'revoke', expectedRevision: 2, confirmed: true });
  release(Response.json({})); await rejected;
  expect(probeFetch).toHaveBeenCalledOnce();
  expect((await service.act('hr', { kind: 'status' })).connectionCheck).toBeUndefined();
});
const oauthPrepare = vi.fn(async () => ({ clientId: 'public-client', authorizationUrl: 'https://workable.com/oauth/authorize' }));
const oauthComplete = vi.fn(async () => grant);
const withOAuth = () => new WorkableConnectionService({ ...options, oauth: { prepare: oauthPrepare, complete: oauthComplete } });
async function connect(service = create()) {
  await service.acceptVerifiedGrant({ organizationId: 'org', actorAccountId: 'hr', expectedRevision: 0, ...grant });
  await service.act('hr', { kind: 'bind', jobId: 'job', expectedRevision: 1, account: 'acme', shortcode: 'FRONT', confirmed: true });
  return service;
}
beforeEach(() => {
  actors.clear(); records.clear(); jobs.clear(); audit.mockClear(); oauthPrepare.mockClear(); oauthComplete.mockClear();
  for (const [id, isAdmin] of [['hr', false], ['admin', true], ['outsider', false]] as const) actors.set(id, { id, organizationId: 'org', active: true, isAdmin });
  jobs.set('job', { id: 'job', title: '前端', description: 'React', revision: 1, updatedAt: '', updatedBy: 'admin', collaboratorAccountIds: ['hr'], candidates: [] });
});
it('persists PKCE on the server, completes once for the initiating owner and never returns credentials', async () => {
  const service = withOAuth();
  const begin = await service.act('hr', { kind: 'oauth_start', expectedRevision: 0, redirectUri: 'http://127.0.0.1:45678/otto-workable-callback', confirmed: true });
  expect(begin.authorization?.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(begin.authorizationAvailable).toBe(true);
  const pending = (await store.get('org', 'hr'))!.pendingOAuth!;
  expect(pending.verifier).toHaveLength(43);
  expect(JSON.stringify(begin)).not.toContain(pending.verifier);
  await expect(service.act('admin', { kind: 'oauth_complete', state: begin.authorization!.state, code: 'code' })).rejects.toThrow();
  const result = await service.act('hr', { kind: 'oauth_complete', state: begin.authorization!.state, code: 'code' });
  expect(result).toMatchObject({ status: 'binding_required', targets: grant.targets });
  expect(JSON.stringify(result)).not.toContain('secret-token');
  expect((await store.get('org', 'hr'))!.pendingOAuth).toBeUndefined();
  await expect(service.act('hr', { kind: 'oauth_complete', state: begin.authorization!.state, code: 'code' })).rejects.toThrow();
  expect(oauthComplete).toHaveBeenCalledTimes(1);
});
it('rejects OAuth when disabled, unconfirmed, non-loopback or another start is still active', async () => {
  const action = { kind: 'oauth_start' as const, expectedRevision: 0, redirectUri: 'http://127.0.0.1:45678/otto-workable-callback', confirmed: true as const };
  await expect(create().act('hr', action)).rejects.toThrow();
  await expect(withOAuth().act('hr', { ...action, confirmed: false } as typeof action)).rejects.toThrow();
  await expect(withOAuth().act('hr', { ...action, redirectUri: 'https://evil.example' })).rejects.toThrow();
  const begin = await withOAuth().act('hr', action);
  await expect(withOAuth().act('hr', { ...action, expectedRevision: begin.revision })).rejects.toThrow();
  expect(oauthPrepare).toHaveBeenCalledTimes(1);
});
it('cancellation, revoke and expiry invalidate pending authorization, including a delayed exchange', async () => {
  for (const kind of ['oauth_cancel', 'revoke', 'expire'] as const) {
    records.clear();
    const service = withOAuth();
    const begin = await service.act('hr', { kind: 'oauth_start', expectedRevision: 0, redirectUri: 'http://127.0.0.1:45678/otto-workable-callback', confirmed: true });
    if (kind === 'oauth_cancel') await service.act('hr', { kind, state: begin.authorization!.state, confirmed: true });
    else if (kind === 'revoke') await service.act('hr', { kind, expectedRevision: begin.revision, confirmed: true });
    else records.get(key('org', 'hr'))!.pendingOAuth!.expiresAt = 0;
    await expect(service.act('hr', { kind: 'oauth_complete', state: begin.authorization!.state, code: 'code' })).rejects.toThrow();
  }
  records.clear();
  const service = withOAuth();
  const begin = await service.act('hr', { kind: 'oauth_start', expectedRevision: 0, redirectUri: 'http://127.0.0.1:45678/otto-workable-callback', confirmed: true });
  oauthComplete.mockImplementationOnce(async () => {
    await service.act('hr', { kind: 'oauth_cancel', state: begin.authorization!.state, confirmed: true }); return grant;
  });
  await expect(service.act('hr', { kind: 'oauth_complete', state: begin.authorization!.state, code: 'code' })).rejects.toThrow();
  expect((await store.get('org', 'hr'))!.grant).toBeNull();
});
it('lets assigned HR bind their own authorization and resolves it for the existing session factory', async () => {
  const service = await connect();
  expect(await service.resolveGrant(scope, new AbortController().signal)).toMatchObject({ ...scope, account: 'acme', jobShortcode: 'FRONT', accessToken: grant.accessToken });
  const view = await service.act('hr', { kind: 'status', jobId: 'job' });
  expect(view).toMatchObject({ revision: 2, status: 'bound_pending_acceptance', binding: { account: 'acme', shortcode: 'FRONT' } });
  expect(JSON.stringify(view)).not.toContain('secret-token'); expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-token');
});
it('lets a non-admin job owner bind their own authorization without a redundant collaborator entry', async () => {
  jobs.set('job', { ...jobs.get('job')!, ownerAccountId: 'hr', collaboratorAccountIds: [] });
  const service = await connect();
  expect(await service.resolveGrant(scope, new AbortController().signal)).toMatchObject({ actorAccountId: 'hr', account: 'acme' });
});
it('never lends an administrator or coworker token, even if they can access the same shared job', async () => {
  const service = await connect();
  expect(await service.resolveGrant({ ...scope, actorAccountId: 'admin' }, new AbortController().signal)).toBeNull();
  expect(await service.resolveGrant({ ...scope, organizationId: 'foreign' }, new AbortController().signal)).toBeNull();
  expect(await service.resolveGrant({ ...scope, actorAccountId: 'outsider' }, new AbortController().signal)).toBeNull();
  await expect(service.act('outsider', { kind: 'status', jobId: 'job' })).rejects.toThrow(/岗位/);
});
it('rejects invented accounts/jobs, missing confirmation and stale binding revisions', async () => {
  const service = await connect();
  const action = { kind: 'bind' as const, jobId: 'job', expectedRevision: 2, account: 'acme', shortcode: 'FRONT', confirmed: true as const };
  for (const patch of [{ account: 'other' }, { shortcode: 'OTHER' }, { confirmed: false }, { expectedRevision: 1 }]) await expect(service.act('hr', { ...action, ...patch } as typeof action)).rejects.toThrow();
  expect((await store.get('org', 'hr'))?.revision).toBe(2);
});
it('revokes without retaining tokens and prevents delayed OAuth completion from resurrecting them', async () => {
  const service = await connect();
  await service.act('hr', { kind: 'revoke', expectedRevision: 2, confirmed: true });
  expect(await service.resolveGrant(scope, new AbortController().signal)).toBeNull();
  expect(await store.get('org', 'hr')).toEqual({ revision: 3, grant: null, bindings: [] });
  await expect(service.acceptVerifiedGrant({ organizationId: 'org', actorAccountId: 'hr', expectedRevision: 2, ...grant })).rejects.toThrow(/变化/);
  expect((await service.act('hr', { kind: 'status', jobId: 'job' })).status).toBe('authorization_required');
});
it('stops reads immediately after job access, account activity, or token validity changes', async () => {
  const service = await connect();
  jobs.get('job')!.collaboratorAccountIds = [];
  expect(await service.resolveGrant(scope, new AbortController().signal)).toBeNull();
  jobs.get('job')!.collaboratorAccountIds = ['hr']; actors.get('hr')!.active = false;
  expect(await service.resolveGrant(scope, new AbortController().signal)).toBeNull();
  actors.get('hr')!.active = true;
  records.get(key('org', 'hr'))!.grant!.expiresAt = '2000-01-01T00:00:00Z';
  expect(await service.resolveGrant(scope, new AbortController().signal)).toBeNull();
  expect((await service.act('hr', { kind: 'status', jobId: 'job' })).status).toBe('expired');
});
it('changes the binding identity after rebind and clears all prior bindings after reauthorization', async () => {
  const service = await connect();
  const before = await service.resolveGrant(scope, new AbortController().signal);
  await service.act('hr', { kind: 'unbind', jobId: 'job', expectedRevision: 2, confirmed: true });
  expect(await service.resolveGrant(scope, new AbortController().signal)).toBeNull();
  await service.act('hr', { kind: 'bind', jobId: 'job', expectedRevision: 3, account: 'acme', shortcode: 'FRONT', confirmed: true });
  expect((await service.resolveGrant(scope, new AbortController().signal))?.bindingRevision).not.toBe(before?.bindingRevision);
  await service.acceptVerifiedGrant({ organizationId: 'org', actorAccountId: 'hr', expectedRevision: 4, ...grant });
  expect((await service.act('hr', { kind: 'status', jobId: 'job' })).status).toBe('binding_required');
});
it('rechecks state after asynchronous ACL checks and rejects cancelled reads', async () => {
  const service = await connect();
  const racing = new WorkableConnectionService({ ...options, getActor: async (id) => {
    records.delete(key('org', 'hr')); return actors.get(id) ?? null;
  } });
  expect(await racing.resolveGrant(scope, new AbortController().signal)).toBeNull();
  await expect(service.resolveGrant(scope, AbortSignal.abort())).rejects.toThrow();
});
it('requires production audit before saving any grant', async () => {
  const service = new WorkableConnectionService({ ...options, audit: async () => { throw new Error('audit unavailable'); } });
  await expect(service.acceptVerifiedGrant({ organizationId: 'org', actorAccountId: 'hr', expectedRevision: 0, ...grant })).rejects.toThrow();
  expect(records.size).toBe(0);
});
it('allows viewing and revoking personal authorization without any remaining shared job access', async () => {
  const service = await connect();
  jobs.clear();
  const view = await service.act('hr', { kind: 'status' });
  expect(view.revision).toBe(2);
  await service.act('hr', { kind: 'revoke', expectedRevision: view.revision, confirmed: true });
  expect((await service.act('hr', { kind: 'status' })).status).toBe('authorization_required');
});
it('plugs the encrypted-grant broker into the existing MCP session and invalidates open sessions on rebind', async () => {
  const service = await connect();
  const open = createWorkableMcpSessionFactory({ resolveGrant: (input, signal) => service.resolveGrant(input, signal) });
  const session = await open(scope, new AbortController().signal);
  await session.assertAuthorized();
  await service.act('hr', { kind: 'bind', jobId: 'job', expectedRevision: 2, account: 'acme', shortcode: 'FRONT', confirmed: true });
  await expect(session.assertAuthorized()).rejects.toThrow(/绑定/);
  await session.close();
});
it('allows only one concurrent binding write at the same revision', async () => {
  const service = await connect();
  const action = { kind: 'bind' as const, jobId: 'job', expectedRevision: 2, account: 'acme', shortcode: 'FRONT', confirmed: true as const };
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => service.act('hr', action)));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await store.get('org', 'hr'))?.revision).toBe(3);
});
