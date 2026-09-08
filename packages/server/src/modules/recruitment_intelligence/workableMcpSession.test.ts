import { describe, expect, it, vi } from 'vitest';
import { createWorkableMcpSessionFactory, createWorkableRecruitmentRegistration, type WorkableOAuthGrant } from './workableMcpSession.js';
import { createWorkableRecruitmentAdapter } from './workableRecruitmentAdapter.js';

const scope = { organizationId: 'org', actorAccountId: 'hr', requisitionId: 'job' };
const grant: WorkableOAuthGrant = { ...scope, account: 'acme', jobShortcode: 'FRONT', bindingRevision: '1', accessToken: 'test-access-token', expiresAt: '2099-01-01T00:00:00Z' };
const signal = new AbortController().signal;
function fixture() {
  const resolveGrant = vi.fn(async (): Promise<WorkableOAuthGrant | null> => ({ ...grant }));
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'workable', version: 'fixture' } }
      : body.method === 'tools/list' ? { tools: [{ name: 'get_accounts', inputSchema: { type: 'object', properties: {} } }] }
        : { structuredContent: { accounts: [{ subdomain: 'acme' }] } };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });
  return { resolveGrant, fetchMock, open: createWorkableMcpSessionFactory({ resolveGrant, fetch: fetchMock }) };
}

describe('Workable scoped stateless JSON MCP transport', () => {
  it('keeps the public registration disabled until a real-account acceptance reference is recorded', () => {
    const f = fixture();
    const registration = createWorkableRecruitmentRegistration({ resolveGrant: f.resolveGrant, fetch: f.fetchMock });
    expect(registration).toMatchObject({ accessMode: 'authorized_mcp', productionEnabled: false, adapter: { id: 'workable' } });
    expect(registration.authorizationReference).toBeUndefined();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it('initializes, discovers schemas and sends credentials only to the fixed official endpoint', async () => {
    const f = fixture();
    const session = await f.open(scope, signal);
    expect(await session.listTools()).toEqual([{ name: 'get_accounts', inputSchema: { type: 'object', properties: {}, required: [] } }]);
    await session.callTool('get_accounts', {});
    expect(f.fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    for (const [url, init] of f.fetchMock.mock.calls) {
      expect(url).toBe('https://mcp.workable.com/mcp');
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access-token');
      expect(String(init?.body)).not.toContain('test-access-token');
    }
    await session.close();
    await expect(session.listTools()).rejects.toThrow(/关闭/);
  });

  it.each(['organizationId', 'actorAccountId', 'requisitionId', 'expiresAt', 'accessToken'] as const)('rejects invalid %s before network access', async (field) => {
    const f = fixture();
    f.resolveGrant.mockResolvedValue({ ...grant, [field]: field === 'expiresAt' ? '2000-01-01T00:00:00Z' : field === 'accessToken' ? 'bad\r\ntoken' : 'other' });
    await expect(f.open(scope, signal)).rejects.toThrow(/授权/);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('rechecks revocation and binding changes before each call; never falls back to a global token', async () => {
    const f = fixture();
    const session = await f.open(scope, signal);
    await session.listTools();
    const count = f.fetchMock.mock.calls.length;
    f.resolveGrant.mockResolvedValue(null);
    await expect(session.callTool('get_accounts', {})).rejects.toThrow(/授权/);
    expect(f.fetchMock).toHaveBeenCalledTimes(count);
  });

  it('rejects writes and cross-account arguments regardless of tool discovery', async () => {
    const f = fixture();
    const session = await f.open(scope, signal);
    await expect(session.callTool('send_outreach', {})).rejects.toThrow(/只读/);
    await expect(session.callTool('get_candidates', { account: 'other', shortcode: 'FRONT' })).rejects.toThrow(/绑定/);
    await expect(session.callTool('get_candidates', { account: 'acme', shortcode: 'OTHER' })).rejects.toThrow(/绑定/);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 302])('does not retry or echo upstream body on HTTP %s', async (status) => {
    const f = fixture();
    f.fetchMock.mockResolvedValue(new Response('private candidate test-access-token', { status }));
    const session = await f.open(scope, signal);
    await expect(session.listTools()).rejects.not.toThrow(/private|test-access-token/);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['oversize', 'wrong-id', 'rpc-error', 'sse', 'session', 'protocol'])('rejects %s responses instead of claiming readiness', async (kind) => {
    const f = fixture();
    f.fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (kind === 'sse') return new Response('data: private', { headers: { 'content-type': 'text/event-stream' } });
      if (kind === 'oversize') return Response.json({ huge: 'x'.repeat(2_000_001) });
      return Response.json({ jsonrpc: '2.0', id: kind === 'wrong-id' ? 'other' : body.id,
        ...(kind === 'rpc-error' ? { error: { message: 'private test-access-token' } }
          : { result: { protocolVersion: kind === 'protocol' ? '1900-01-01' : '2025-06-18', capabilities: { tools: {} } } }),
      }, kind === 'session' ? { headers: { 'mcp-session-id': 'unexpected' } } : undefined);
    });
    const session = await f.open(scope, signal);
    await expect(session.listTools()).rejects.toThrow(/Workable/);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a response if the grant is revoked while the HTTP request is running', async () => {
    const f = fixture();
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (...args) => {
      const response = await original(...args);
      f.resolveGrant.mockResolvedValue(null);
      return response;
    });
    const session = await f.open(scope, signal);
    await expect(session.listTools()).rejects.toThrow(/授权/);
  });

  it('runs the adapter through the real transport with synthetic HTTP responses and no model calls', async () => {
    const f = fixture();
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      let result: unknown;
      if (body.method === 'tools/list') result = { tools: [
        { name: 'get_accounts', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_candidates', inputSchema: { type: 'object', properties: { account: { type: 'string' }, shortcode: { type: 'string' }, limit: { type: 'integer' } }, required: ['account', 'shortcode'] } },
        { name: 'get_candidate', inputSchema: { type: 'object', properties: { account: { type: 'string' }, id: { type: 'string' } }, required: ['account', 'id'] } },
      ] };
      else if (body.method === 'tools/call' && body.params.name === 'get_candidates') result = { content: [{ type: 'text', text: JSON.stringify({ candidates: [{ id: '1', name: 'A' }] }) }] };
      else return original(url, init);
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    });
    const adapter = createWorkableRecruitmentAdapter({ openSession: f.open });
    const result = await adapter.search({ ...scope, query: 'React', limit: 10 }, { signal });
    expect(result.candidates[0].displayName).toBe('A');
  });
});
