/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createServer } from 'node:http';
import type { WorkableConnectionAction, WorkableConnectionView } from 'otto-server';

/** Loopback callback never carries an Otto session token. Codes stay in main, not renderer. */
export class WorkableDesktopLogin {
  private active?: { scopeId: string; controller: AbortController };
  cancel(scopeId: string): void { if (this.active?.scopeId === scopeId) this.active.controller.abort(); }
  async start(options: {
    scopeId: string; expectedRevision: number;
    connection(action: WorkableConnectionAction): Promise<WorkableConnectionView>;
    assertCurrent(): void;
    openExternal(url: string): Promise<void>;
    timeoutMs?: number;
  }): Promise<WorkableConnectionView> {
    if (this.active) throw new Error('已有 Workable 授权正在进行，请先取消');
    options.assertCurrent();
    const controller = new AbortController(); this.active = { scopeId: options.scopeId, controller };
    let state: string | undefined; let completed = false; let consumed = false;
    let resolveCode!: (code: string) => void; let rejectCode!: (reason: Error) => void;
    const callback = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    void callback.catch(() => undefined);
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('X-Content-Type-Options', 'nosniff');
      const address = server.address();
      if (!address || typeof address === 'string' || req.method !== 'GET' || req.headers.host !== `127.0.0.1:${address.port}` || !req.url || req.url.length > 4096 || !req.url.startsWith('/')) { res.writeHead(400); res.end('无效回调'); return; }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (consumed || !state || url.origin !== `http://${req.headers.host}` || url.pathname !== '/otto-workable-callback' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state
        || (url.searchParams.has('iss') && (url.searchParams.getAll('iss').length !== 1 || url.searchParams.get('iss') !== 'https://mcp.workable.com'))
        || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1) { res.writeHead(400); res.end('无效或已使用的授权回调'); return; }
      try { options.assertCurrent(); controller.signal.throwIfAborted(); }
      catch { res.writeHead(409); res.end('Otto 登录已变化，请重新授权'); controller.abort(); return; }
      if (url.searchParams.has('error')) {
        consumed = true; res.end('授权未完成，请返回 Otto 查看。'); rejectCode(new Error('Workable 授权已取消或被平台拒绝')); return;
      }
      const code = url.searchParams.get('code');
      if (!code || !/^[\x21-\x7E]{1,2048}$/u.test(code)) { res.writeHead(400); res.end('授权码无效'); return; }
      consumed = true; res.end('已收到授权结果，请返回 Otto 等待账号与岗位校验。'); resolveCode(code);
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxConnections = 8;
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 600_000);
    const sessionCheck = setInterval(() => { try { options.assertCurrent(); } catch { controller.abort(); } }, 500);
    const abort = () => { rejectCode(new Error('Workable 授权已取消或超时')); server.closeAllConnections(); void server.close(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法建立本机授权回调');
      const redirectUri = `http://127.0.0.1:${address.port}/otto-workable-callback`;
      options.assertCurrent(); controller.signal.throwIfAborted();
      const begin = await options.connection({ kind: 'oauth_start', expectedRevision: options.expectedRevision, redirectUri, confirmed: true });
      state = begin.authorization?.state;
      options.assertCurrent(); controller.signal.throwIfAborted();
      if (!state || !/^[A-Za-z0-9_-]{43}$/u.test(state) || !begin.authorization?.url) throw new Error('服务器未返回有效授权入口');
      const url = new URL(begin.authorization.url);
      const required = { state, redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256', resource: 'https://mcp.workable.com/mcp', scope: 'r_account r_jobs r_candidates' };
      if (url.origin !== 'https://workable.com' || url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash
        || url.searchParams.getAll('client_id').length !== 1 || !url.searchParams.get('client_id') || url.searchParams.getAll('code_challenge').length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('code_challenge') ?? '')
        || !Object.entries(required).every(([key, value]) => url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value)
        || [...url.searchParams.keys()].some((key) => ![...Object.keys(required), 'client_id', 'code_challenge'].includes(key))) throw new Error('Workable 授权地址未通过安全检查');
      await options.openExternal(url.href);
      const code = await callback;
      options.assertCurrent(); controller.signal.throwIfAborted();
      const result = await options.connection({ kind: 'oauth_complete', state, code });
      options.assertCurrent(); controller.signal.throwIfAborted();
      completed = true; return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Workable 授权已取消或超时');
      if (error instanceof Error && /Workable|服务器未返回|本机授权/.test(error.message)) throw error;
      throw new Error('Workable 授权未完成，请刷新状态后重试');
    } finally {
      clearTimeout(timer); clearInterval(sessionCheck); controller.signal.removeEventListener('abort', abort);
      server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()); });
      if (!completed && state) {
        try { options.assertCurrent(); await options.connection({ kind: 'oauth_cancel', state, confirmed: true }); } catch { /* Do not send the old flow to a new enterprise. Server TTL bounds abandoned flows. */ }
      }
      this.active = undefined;
    }
  }
}
