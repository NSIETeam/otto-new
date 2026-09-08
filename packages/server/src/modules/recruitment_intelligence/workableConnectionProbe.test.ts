import { expect, it, vi } from 'vitest';
import { probeWorkableConnection, type WorkableRecruitmentSession } from './workableRecruitmentAdapter.js';

function fixture() {
  const tools = [
    { name: 'get_accounts', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'get_candidates', inputSchema: { type: 'object', properties: { account: { type: 'string' }, shortcode: { type: 'string' }, limit: { type: 'integer' } }, required: ['account', 'shortcode'] } },
    { name: 'get_candidate', inputSchema: { type: 'object', properties: { account: { type: 'string' }, id: { type: 'integer' } }, required: ['account', 'id'] } },
  ];
  const session: WorkableRecruitmentSession = { account: 'acme', jobShortcode: 'FRONT', bindingRevision: 'rev', listTools: vi.fn(async () => tools), callTool: vi.fn(async () => ({ accounts: [{ subdomain: 'acme' }] })), assertAuthorized: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  return { session, tools, probe: () => probeWorkableConnection(session, new AbortController().signal) };
}
it('checks read tool schemas and the selected account, without reading candidates or claiming resume acceptance', async () => {
  const f = fixture();
  await f.probe();
  expect(f.session.callTool).toHaveBeenCalledExactlyOnceWith('get_accounts', {});
  expect(f.session.close).toHaveBeenCalledOnce();
});
it('fails unsupported required fields before calling the provider account tool', async () => {
  const f = fixture(); f.tools[1]!.inputSchema.required.push('unknown');
  await expect(f.probe()).rejects.toThrow(/契约/);
  expect(f.session.callTool).not.toHaveBeenCalled();
  expect(f.session.close).toHaveBeenCalledOnce();
});
it('does not report success for a removed account, revoked grant or cancelled request', async () => {
  const f = fixture();
  vi.mocked(f.session.callTool).mockResolvedValue({ accounts: [{ subdomain: 'other' }] });
  await expect(f.probe()).rejects.toThrow();
  vi.mocked(f.session.assertAuthorized).mockRejectedValue(new Error('revoked'));
  await expect(f.probe()).rejects.toThrow();
  await expect(probeWorkableConnection(f.session, AbortSignal.abort())).rejects.toThrow();
});
