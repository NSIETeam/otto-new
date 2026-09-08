import { afterEach, expect, it, vi } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core/recurring-tasks';
import { WorkableDesktopLogin } from './workableOAuthLogin.js';
import type { WorkableConnectionAction, WorkableConnectionView } from 'otto-server';
const state = 's'.repeat(43);
const view: WorkableConnectionView = { revision: 2, authorizationAvailable: true, status: 'binding_required', targets: [] };
afterEach(() => vi.restoreAllMocks());
function fixture() {
  let redirectUri = '';
  const connection = vi.fn(async (action: WorkableConnectionAction) => {
    if (action.kind === 'oauth_start') {
      redirectUri = action.redirectUri;
      const url = new URL('https://workable.com/oauth/authorize'); url.search = new URLSearchParams({ state, client_id: 'fixture-client', code_challenge: 'c'.repeat(43), redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256', resource: 'https://mcp.workable.com/mcp', scope: 'r_account r_jobs r_candidates' }).toString();
      return { ...view, authorization: { url: url.href, state } };
    }
    return view;
  });
  const controller = new WorkableDesktopLogin();
  return { controller, connection, callback: () => redirectUri, assertCurrent: vi.fn(), scopeId: 'org:hr', expectedRevision: 0 };
}
it('accepts only the matching loopback callback and sends the one-time code to the captured enterprise session', async () => {
  const f = fixture();
  const result = await f.controller.start({ ...f, openExternal: async () => {
    expect((await fetch(`${f.callback()}?state=wrong&code=bad`)).status).toBe(400);
    expect((await fetch(`${f.callback()}?state=${state}&code=bad&iss=https://evil.example`)).status).toBe(400);
    expect((await fetch(`${f.callback()}?state=${state}&code=bad&code=duplicate`)).status).toBe(400);
    const response = await fetch(`${f.callback()}?state=${state}&code=one-time`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('one-time');
  } });
  expect(result).toEqual(view);
  expect(f.connection).toHaveBeenCalledWith({ kind: 'oauth_complete', state, code: 'one-time' });
});
it('handles user denial and timeout without exchanging tokens', async () => {
  const f = fixture();
  await expect(f.controller.start({ ...f, openExternal: async () => { await fetch(`${f.callback()}?state=${state}&error=access_denied&error_description=private-detail`); } })).rejects.toThrow(/取消|拒绝/);
  await expect(f.controller.start({ ...f, timeoutMs: 25, openExternal: async () => undefined })).rejects.toThrow(/超时/);
  expect(f.connection.mock.calls.some(([action]) => action.kind === 'oauth_complete')).toBe(false);
});
it('rejects non-official authorization URLs without launching a browser, then cancels the pending flow', async () => {
  const f = fixture(); const original = f.connection.getMockImplementation()!;
  f.connection.mockImplementation(async (action) => action.kind === 'oauth_start' ? { ...await original(action), authorization: { state, url: 'https://evil.example' } } : view);
  const openExternal = vi.fn();
  await expect(f.controller.start({ ...f, openExternal })).rejects.toThrow();
  expect(openExternal).not.toHaveBeenCalled();
  expect(f.connection).toHaveBeenCalledWith({ kind: 'oauth_cancel', state, confirmed: true });
});
it('cancels the listener and pending authorization without exchanging a code', async () => {
  const f = fixture();
  await expect(f.controller.start({ ...f, openExternal: async () => { f.controller.cancel(f.scopeId); } })).rejects.toThrow(/取消/);
  expect(f.connection.mock.calls.some(([action]) => action.kind === 'oauth_complete')).toBe(false);
  expect(f.connection).toHaveBeenCalledWith({ kind: 'oauth_cancel', state, confirmed: true });
});
it('refuses completion after switching enterprise and does not send codes to the new session', async () => {
  const f = fixture();
  await expect(f.controller.start({ ...f, openExternal: async () => {
    await fetch(`${f.callback()}?state=${state}&code=one-time`);
    f.assertCurrent.mockImplementation(() => { throw new Error('changed'); });
  } })).rejects.toThrow();
  expect(f.connection.mock.calls.some(([action]) => action.kind === 'oauth_complete')).toBe(false);
});
it('registers a free session watcher and stops it after an account change without a callback', async () => {
  const register = vi.spyOn(RecurringTaskRegistry.prototype, 'register');
  const f = fixture();
  await expect(f.controller.start({ ...f, timeoutMs: 2_000, openExternal: async () => {
    f.assertCurrent.mockImplementation(() => { throw new Error('changed'); });
  } })).rejects.toThrow(/取消/);
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 500, estimatedCostUsdPerRun: 0 }));
  expect((register.mock.contexts[0] as RecurringTaskRegistry).list()).toEqual([]);
  expect(f.connection.mock.calls.some(([action]) => action.kind === 'oauth_complete')).toBe(false);
});
