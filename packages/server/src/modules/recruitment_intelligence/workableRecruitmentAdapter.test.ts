import { describe, expect, it, vi } from 'vitest';
import { createWorkableRecruitmentAdapter, type WorkableRecruitmentSession, type WorkableTool } from './workableRecruitmentAdapter.js';
import { createRecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';

// Synthetic contract fixtures, NOT captured responses from a production account.
const scope = { organizationId: 'org-a', actorAccountId: 'hr-a', requisitionId: 'job-a' };
const input = { ...scope, query: 'React 前端', limit: 2 };
const signal = new AbortController().signal;
const tool = (name: string, properties: Record<string, unknown>, required: string[] = Object.keys(properties)): WorkableTool => ({ name, inputSchema: { type: 'object', properties, required } });
const tools = [
  tool('get_accounts', {}),
  tool('get_candidates', { account: { type: 'string' }, shortcode: { type: 'string' }, limit: { type: 'integer' }, since_id: { type: 'string' } }, ['account', 'shortcode']),
  tool('get_candidate', { account: { type: 'string' }, id: { type: 'string' } }),
  tool('send_outreach', {}),
];
function fixture() {
  const callTool = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'get_accounts') return { accounts: [{ subdomain: 'acme' }] };
    if (name === 'get_candidates') return { candidates: [{ id: 'p1', name: '候选人 A', headline: 'React 工程师' }], paging: { next: null } };
    return { candidate: { id: 'p1', name: '候选人 A', summary: '交付过企业应用', resume_url: 'https://files.example.test/resume.pdf?secret=signed' } };
  });
  const session: WorkableRecruitmentSession = {
    account: 'acme', jobShortcode: 'FRONT', bindingRevision: '1',
    listTools: vi.fn(async () => structuredClone(tools)), callTool,
    assertAuthorized: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
  const openSession = vi.fn(async () => session);
  return { session, callTool, openSession, adapter: createWorkableRecruitmentAdapter({ openSession }) };
}

describe('Workable read-only adapter', () => {
  it('reads the freshly returned resume URL through the reviewed reader, not a list/profile URL', async () => {
    const f = fixture();
    const reader = vi.fn(async (request) => ({ sourceRecordId: request.sourceRecordId, text: 'React engineer with TypeScript delivery and testing experience.', completeness: 'full_text' as const }));
    const adapter = createWorkableRecruitmentAdapter({ openSession: f.openSession, resumeReader: reader });
    const result = await adapter.search(input, { signal });
    const material = await adapter.getCandidate!({ ...scope, sourceRecordId: result.candidates[0].sourceRecordId }, { signal });
    expect(material.completeness).toBe('full_text');
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://files.example.test/resume.pdf?secret=signed', signal, assertAuthorized: expect.any(Function) }));
    expect(JSON.stringify(material)).not.toContain('secret');
  });

  it('does not downgrade a failed resume download to a successful profile read', async () => {
    const f = fixture();
    const adapter = createWorkableRecruitmentAdapter({ openSession: f.openSession, resumeReader: async () => { throw new Error('secret download error'); } });
    const result = await adapter.search(input, { signal });
    await expect(adapter.getCandidate!({ ...scope, sourceRecordId: result.candidates[0].sourceRecordId }, { signal })).rejects.not.toThrow(/secret/);
  });
  it('selects the authorized account before listing the bound job; never sends Otto scope or free text to platform tools', async () => {
    const f = fixture();
    const result = await f.adapter.search(input, { signal });
    expect(f.openSession).toHaveBeenCalledWith(scope, signal);
    expect(f.callTool.mock.calls).toEqual([['get_accounts', {}], ['get_candidates', { account: 'acme', shortcode: 'FRONT', limit: 2 }]]);
    expect(result).toMatchObject({ candidates: [{ displayName: '候选人 A' }], notice: expect.stringContaining('不是全站人才搜索') });
    expect(result.notice).toContain('未按自由文本筛选');
    expect(f.adapter.capabilities).toEqual(['search_candidates', 'get_candidate']);
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it('keeps a profile partial and never downloads a signed URL by default', async () => {
    const f = fixture();
    const { candidates } = await f.adapter.search(input, { signal });
    const material = await f.adapter.getCandidate!({ ...scope, sourceRecordId: candidates[0].sourceRecordId }, { signal });
    expect(material).toMatchObject({ completeness: 'partial', text: expect.stringContaining('交付过企业应用') });
    expect(material.text).not.toContain('secret');
    expect(f.callTool.mock.calls.at(-1)).toEqual(['get_candidate', { account: 'acme', id: 'p1' }]);
  });

  it.each(['other-account', 'missing-account'])('does not read candidates with %s', async (kind) => {
    const f = fixture();
    f.callTool.mockResolvedValue({ accounts: kind === 'other-account' ? [{ subdomain: 'other' }] : [] });
    await expect(f.adapter.search(input, { signal })).rejects.toThrow(/账号/);
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it('binds stored record IDs and pagination to tenant, actor, job and binding revision', async () => {
    const f = fixture();
    const { candidates } = await f.adapter.search(input, { signal });
    for (const changed of [{ ...scope, organizationId: 'org-b' }, { ...scope, actorAccountId: 'hr-b' }, { ...scope, requisitionId: 'job-b' }]) {
      await expect(f.adapter.getCandidate!({ ...changed, sourceRecordId: candidates[0].sourceRecordId }, { signal })).rejects.toThrow(/绑定/);
    }
    f.session.bindingRevision = '2';
    await expect(f.adapter.getCandidate!({ ...scope, sourceRecordId: candidates[0].sourceRecordId }, { signal })).rejects.toThrow(/绑定/);
    expect(f.callTool.mock.calls.filter(([name]) => name === 'get_candidate')).toHaveLength(0);
  });

  it.each(['missing', 'duplicate', 'unknown-required', 'ambiguous'])('fails closed on %s discovered tool contract', async (kind) => {
    const f = fixture();
    const discovered = structuredClone(tools);
    if (kind === 'missing') discovered.splice(1, 1);
    if (kind === 'duplicate') discovered.push(discovered[1]);
    if (kind === 'unknown-required') discovered[1].inputSchema.required.push('unreviewed_filter');
    if (kind === 'ambiguous') discovered[1].inputSchema.properties.job_shortcode = { type: 'string' };
    f.session.listTools = async () => discovered;
    await expect(f.adapter.search(input, { signal })).rejects.toThrow(/工具契约/);
    expect(f.callTool.mock.calls.some(([name]) => name === 'get_candidates')).toBe(false);
  });

  it('accepts schema-advertised aliases and rejects detail responses for a different person', async () => {
    const f = fixture();
    f.session.listTools = async () => [tools[0], tools[1], tool('get_candidate', { account: { type: 'string' }, candidate_id: { type: 'integer' } })];
    f.callTool.mockImplementation(async (name) => name === 'get_accounts' ? { accounts: [{ subdomain: 'acme' }] }
      : name === 'get_candidates' ? { candidates: [{ id: 123, name: '候选人' }] }
        : { candidate: { id: 456, summary: '另一个人的资料' } });
    const result = await f.adapter.search(input, { signal });
    await expect(f.adapter.getCandidate!({ ...scope, sourceRecordId: result.candidates[0].sourceRecordId }, { signal })).rejects.toThrow(/不匹配/);
    expect(f.callTool.mock.calls.at(-1)).toEqual(['get_candidate', { account: 'acme', candidate_id: 123 }]);
  });

  it('retains next-page state without fetching provider-supplied URLs', async () => {
    const f = fixture();
    const original = f.callTool.getMockImplementation()!;
    f.callTool.mockImplementation(async (name, args) => name === 'get_candidates'
      ? { candidates: [{ id: args.since_id ? 'p2' : 'p1', name: 'A' }], paging: { next: args.since_id ? null : 'https://acme.workable.com/spi/v3/jobs/FRONT/candidates?since_id=p1&limit=2' } }
      : original(name, args));
    const first = await f.adapter.search(input, { signal });
    expect(first.nextCursor).toBeTruthy();
    await f.adapter.search({ ...input, cursor: first.nextCursor }, { signal });
    expect(f.callTool.mock.calls.at(-1)?.[1]).toMatchObject({ since_id: 'p1' });
    await expect(f.adapter.search({ ...input, requisitionId: 'other', cursor: first.nextCursor }, { signal })).rejects.toThrow(/绑定/);
  });

  it.each(['https://evil.test/?since_id=x', 'http://127.0.0.1/?since_id=x', 'https://acme.workable.com/spi/v3/jobs/OTHER/candidates?since_id=x', 'https://acme.workable.com/spi/v3/jobs/FRONT/candidates?page=2'])('rejects unreviewed pagination %s', async (next) => {
    const f = fixture();
    f.callTool.mockImplementation(async (name) => name === 'get_accounts' ? { accounts: [{ subdomain: 'acme' }] } : { candidates: [], paging: { next } });
    await expect(f.adapter.search(input, { signal })).rejects.toThrow(/分页/);
  });

  it('rejects partial tool errors and redacts raw upstream exceptions', async () => {
    const f = fixture();
    f.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'secret-raw-upstream' }] });
    await expect(f.adapter.search(input, { signal })).rejects.toThrow(/Workable/);
    f.callTool.mockRejectedValue(new Error('secret-raw-upstream'));
    await expect(f.adapter.search(input, { signal })).rejects.not.toThrow(/secret/);
  });

  it('discards results if authorization is revoked during a tool call', async () => {
    const f = fixture();
    const original = f.callTool.getMockImplementation()!;
    f.callTool.mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (name === 'get_candidates') f.session.assertAuthorized = async () => { throw new Error('revoked-secret'); };
      return result;
    });
    await expect(f.adapter.search(input, { signal })).rejects.toThrow(/授权/);
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it('integrates with the existing gateway, provenance reader and disabled-by-default production gate', async () => {
    const f = fixture();
    const registration = { adapter: f.adapter, accessMode: 'authorized_mcp' as const, productionEnabled: false, authorizationReference: 'synthetic-test-review' };
    const runtime = createRecruitmentSourceRuntime({ registrations: [registration], authorizeSource: async () => ({ allowed: true }) });
    expect((await runtime.listSources(scope))[0].searchable).toBe(false);
    expect((await runtime.search(input)).sources[0].status).toBe('unauthorized');
    expect(f.openSession).not.toHaveBeenCalled();
    registration.productionEnabled = true;
    const result = await runtime.search(input);
    expect(result.sources[0]).toMatchObject({ status: 'ok', message: expect.stringContaining('未按自由文本筛选') });
    const material = await runtime.getCandidateMaterial!({ ...scope, runId: result.runId, canonicalId: result.candidates[0].canonicalId, sourceId: 'workable' });
    expect(material.material.completeness).toBe('partial');
    expect(material.source.sourceId).toBe('workable');
  });

  it('shows an actionable safe account error through the gateway without raw upstream data', async () => {
    const f = fixture();
    f.callTool.mockResolvedValue({ accounts: [] });
    const runtime = createRecruitmentSourceRuntime({ registrations: [{ adapter: f.adapter, accessMode: 'authorized_mcp', productionEnabled: true, authorizationReference: 'test' }], authorizeSource: async () => ({ allowed: true }) });
    expect((await runtime.search(input)).sources[0]).toMatchObject({ status: 'error', message: expect.stringContaining('账号') });
  });

  it('rejects a candidate moved out of the bound job after search', async () => {
    const f = fixture();
    const found = await f.adapter.search(input, { signal });
    const original = f.callTool.getMockImplementation()!;
    f.callTool.mockImplementation(async (name, args) => name === 'get_candidate' ? { candidate: { id: 'p1', job: { shortcode: 'OTHER' } } } : original(name, args));
    await expect(f.adapter.getCandidate!({ ...scope, sourceRecordId: found.candidates[0].sourceRecordId }, { signal })).rejects.toThrow(/岗位/);
  });

  it('does not start network calls for an already-cancelled operation', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.adapter.search(input, { signal: controller.signal })).rejects.toThrow();
    expect(f.openSession).not.toHaveBeenCalled();
  });

  it('supports 100 concurrent isolated synthetic searches with stable IDs and no model calls', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 100 }, () => f.adapter.search(input, { signal })));
    expect(new Set(results.map((result) => result.candidates[0].sourceRecordId)).size).toBe(1);
    expect(f.session.close).toHaveBeenCalledTimes(100);
    expect(f.callTool.mock.calls.every(([name]) => ['get_accounts', 'get_candidates'].includes(name))).toBe(true);
  });
});
