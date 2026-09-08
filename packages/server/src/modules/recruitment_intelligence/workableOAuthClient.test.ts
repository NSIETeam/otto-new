import { expect, it, vi } from 'vitest';
import { createWorkableOAuthClient } from './workableOAuthClient.js';

const redirectUri = 'http://127.0.0.1:45678/otto-workable-callback';
const scopes = ['r_account', 'r_jobs', 'r_candidates'];
function fixture() {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('oauth-protected-resource')) return Response.json({ resource: 'https://mcp.workable.com/mcp', authorization_servers: ['https://mcp.workable.com'], scopes_supported: scopes });
    if (path.endsWith('oauth-authorization-server')) return Response.json({ issuer: 'https://mcp.workable.com', authorization_endpoint: 'https://workable.com/oauth/authorize', token_endpoint: 'https://workable.com/oauth/token', registration_endpoint: 'https://mcp.workable.com/oauth/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], scopes_supported: scopes });
    if (path === '/oauth/register') return Response.json({ client_id: 'client-test', token_endpoint_auth_method: 'none', redirect_uris: [redirectUri] }, { status: 201 });
    if (path === '/oauth/token') return Response.json({ access_token: 'secret-access', token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') });
    const body = JSON.parse(String(init?.body));
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [
        { name: 'get_accounts', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_jobs', inputSchema: { type: 'object', properties: { account: { type: 'string' }, state: { type: 'string' }, limit: { type: 'integer' }, since_id: { type: 'string' } }, required: ['account'] } },
      ] } : { structuredContent: body.params.name === 'get_accounts' ? { accounts: [{ subdomain: 'acme' }, { subdomain: 'second' }] } : { jobs: [{ shortcode: 'FRONT', title: '前端工程师' }] } };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });
  return { fetcher, client: createWorkableOAuthClient({ fetch: fetcher, now: () => 1_000_000 }) };
}
it('discovers official endpoints, requests only readonly scopes and binds PKCE/resource/redirect through token exchange', async () => {
  const { client, fetcher } = fixture();
  const prepared = await client.prepare({ redirectUri, state: 's'.repeat(43), verifier: 'v'.repeat(43) }, async () => undefined);
  const url = new URL(prepared.authorizationUrl);
  expect(url.origin + url.pathname).toBe('https://workable.com/oauth/authorize');
  expect(url.searchParams.get('scope')).toBe(scopes.join(' '));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).not.toBe('v'.repeat(43));
  const grant = await client.complete({ ...prepared, redirectUri, verifier: 'v'.repeat(43), code: 'one-time-code' }, async () => undefined);
  expect(grant.targets).toEqual([{ account: 'acme', shortcode: 'FRONT', label: '前端工程师' }, { account: 'second', shortcode: 'FRONT', label: '前端工程师' }]);
  expect(grant.accessToken).toBe('secret-access');
  const token = fetcher.mock.calls.find(([url]) => String(url).endsWith('/oauth/token'))!;
  expect(new URLSearchParams(String(token[1]?.body)).get('resource')).toBe('https://mcp.workable.com/mcp');
  expect(new URLSearchParams(String(token[1]?.body)).get('code_verifier')).toBe('v'.repeat(43));
  for (const [url, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(String(url)).not.toContain('secret-access');
    if (new Headers(init?.headers).has('authorization')) expect(String(url)).toBe('https://mcp.workable.com/mcp');
  }
});
it.each(['http://localhost:45678/otto-workable-callback', 'http://127.0.0.1:1/other', 'https://evil.example/callback', `${redirectUri}?redirect=evil`])('rejects untrusted callback %s before IO', async (redirectUri) => {
  const { client, fetcher } = fixture();
  await expect(client.prepare({ redirectUri, state: 's'.repeat(43), verifier: 'v'.repeat(43) }, async () => undefined)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects changed metadata, missing PKCE, broader tokens, bad registrations and private upstream errors', async () => {
  for (const mode of ['issuer', 'pkce', 'scope', 'registration', 'error']) {
    const f = fixture(); const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (mode === 'error') return new Response('secret private provider detail', { status: 500 });
      if (String(url).endsWith('oauth-authorization-server')) {
        const body = await response.json();
        if (mode === 'issuer') body.token_endpoint = 'https://evil.example/token';
        if (mode === 'pkce') body.code_challenge_methods_supported = ['plain'];
        return Response.json(body);
      }
      if (mode === 'registration' && String(url).endsWith('/oauth/register')) return Response.json({ client_id: 'x', redirect_uris: ['https://evil.example'] });
      if (mode === 'scope' && String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'secret', token_type: 'bearer', expires_in: 3600, scope: `${scopes.join(' ')} w_candidates` });
      return response;
    });
    await expect((async () => {
      const prepared = await f.client.prepare({ redirectUri, state: 's'.repeat(43), verifier: 'v'.repeat(43) }, async () => undefined);
      return f.client.complete({ ...prepared, redirectUri, verifier: 'v'.repeat(43), code: 'code' }, async () => undefined);
    })()).rejects.toThrow(/Workable/);
  }
});
it('stops before further provider reads when the owner revokes during the exchange', async () => {
  const f = fixture(); const check = vi.fn(async () => { if (f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/oauth/token'))) throw new Error('revoked'); });
  await expect(f.client.complete({ clientId: 'id', redirectUri, verifier: 'v'.repeat(43), code: 'code' }, check)).rejects.toThrow();
  expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/mcp'))).toBe(false);
});
