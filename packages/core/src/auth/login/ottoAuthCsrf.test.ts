/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthServer, isTrustedOttoAuthStartRequest } from './authServer.js';
import { OttoAuthHandler } from './ottoAuth.js';
import { OneTimeOttoAuthStateStore } from './ottoAuthState.js';

function callbackUrl(state?: string): URL {
  const url = new URL('http://localhost:7863/callback');
  url.searchParams.set('plat', 'otto');
  url.searchParams.set('token', 'header.payload.signature');
  url.searchParams.set('user_id', 'user-1');
  if (state) url.searchParams.set('state', state);
  return url;
}

type AuthServerTestSurface = {
  handleStartOttoAuth(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleOttoCallback(url: URL, res: ServerResponse): Promise<void>;
};

function testSurface(server: AuthServer): AuthServerTestSurface {
  return server as unknown as AuthServerTestSurface;
}

function requestFrom(
  remoteAddress: string,
  origin?: string,
  secFetchSite?: string,
): IncomingMessage {
  return {
    headers: {
      ...(origin ? { origin } : {}),
      ...(secFetchSite ? { 'sec-fetch-site': secFetchSite } : {}),
    },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function responseRecorder(): {
  response: ServerResponse;
  record: { statusCode: number; headers: Map<string, unknown>; body: string };
} {
  const record = {
    statusCode: 0,
    headers: new Map<string, unknown>([['access-control-allow-origin', '*']]),
    body: '',
  };
  const response = {
    removeHeader: vi.fn((name: string) => {
      record.headers.delete(name.toLowerCase());
    }),
    setHeader: vi.fn((name: string, value: unknown) => {
      record.headers.set(name.toLowerCase(), value);
      return response;
    }),
    writeHead: vi.fn((statusCode: number, headers?: Record<string, unknown>) => {
      record.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers ?? {})) {
        record.headers.set(name.toLowerCase(), value);
      }
      return response;
    }),
    end: vi.fn((chunk?: string | Buffer) => {
      if (chunk !== undefined) record.body += chunk.toString();
      return response;
    }),
  } as unknown as ServerResponse;
  return { response, record };
}

describe('Otto OAuth state protection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('adds the same unguessable state to the provider request and callback URL', () => {
    const handler = new OttoAuthHandler({
      authUrl: 'https://auth.example.test/login?tenant=otto',
      redirectUri: 'http://localhost:7863/callback?plat=otto',
    });
    const state = 'a'.repeat(64);

    const providerUrl = new URL(handler.buildAuthUrl(state));
    const redirectUrl = new URL(providerUrl.searchParams.get('redirect_to')!);

    expect(providerUrl.searchParams.get('tenant')).toBe('otto');
    expect(providerUrl.searchParams.get('state')).toBe(state);
    expect(redirectUrl.searchParams.get('plat')).toBe('otto');
    expect(redirectUrl.searchParams.get('state')).toBe(state);
  });

  it('accepts the matching state exactly once and rejects replay', () => {
    const store = new OneTimeOttoAuthStateStore();
    const handler = new OttoAuthHandler({
      authUrl: 'https://auth.example.test/login',
      redirectUri: 'http://localhost:7863/callback?plat=otto',
    });
    const state = store.issue();

    expect(handler.handleCallback(callbackUrl(state), (value) => store.consume(value)).success).toBe(true);
    expect(handler.handleCallback(callbackUrl(state), (value) => store.consume(value))).toMatchObject({
      success: false,
      error: expect.stringContaining('失效'),
    });
  });

  it.each([
    ['missing', undefined],
    ['incorrect', 'b'.repeat(64)],
  ])('rejects a %s state before accepting callback credentials', (_label, state) => {
    const store = new OneTimeOttoAuthStateStore();
    const handler = new OttoAuthHandler({
      authUrl: 'https://auth.example.test/login',
      redirectUri: 'http://localhost:7863/callback?plat=otto',
    });
    store.issue();

    const result = handler.handleCallback(callbackUrl(state), (value) => store.consume(value));
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('user_id');
  });

  it('does not consume a valid state when a different state is rejected', () => {
    const store = new OneTimeOttoAuthStateStore();
    const handler = new OttoAuthHandler({
      authUrl: 'https://auth.example.test/login',
      redirectUri: 'http://localhost:7863/callback?plat=otto',
    });
    const validState = store.issue();

    expect(handler.handleCallback(callbackUrl('d'.repeat(64)), (value) => store.consume(value)).success).toBe(false);
    expect(handler.handleCallback(callbackUrl(validState), (value) => store.consume(value)).success).toBe(true);
  });

  it('keeps simultaneous login attempts independent', () => {
    const store = new OneTimeOttoAuthStateStore();
    const first = store.issue();
    const second = store.issue();

    expect(store.consume(second)).toBe(true);
    expect(store.consume(first)).toBe(true);
  });

  it('rejects an expired state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T00:00:00.000Z'));
    const store = new OneTimeOttoAuthStateStore({ ttlMs: 60_000 });
    const state = store.issue();

    vi.advanceTimersByTime(60_001);

    expect(store.consume(state)).toBe(false);
  });

  it('only permits same-origin or non-browser requests to start Otto auth', () => {
    expect(isTrustedOttoAuthStartRequest(undefined, undefined, 7862, '127.0.0.1')).toBe(true);
    expect(isTrustedOttoAuthStartRequest('http://localhost:7862', 'same-origin', 7862, '::1')).toBe(true);
    expect(isTrustedOttoAuthStartRequest('http://127.0.0.1:7862', 'same-origin', 7862, '::ffff:127.0.0.1')).toBe(true);
    expect(isTrustedOttoAuthStartRequest('https://evil.example', 'cross-site', 7862, '127.0.0.1')).toBe(false);
    expect(isTrustedOttoAuthStartRequest('http://localhost:9999', 'same-site', 7862, '127.0.0.1')).toBe(false);
    expect(isTrustedOttoAuthStartRequest('null', 'cross-site', 7862, '127.0.0.1')).toBe(false);
    expect(isTrustedOttoAuthStartRequest(undefined, 'none', 7862, '127.0.0.1')).toBe(false);
    expect(isTrustedOttoAuthStartRequest(undefined, undefined, 7862, '192.168.1.20')).toBe(false);
  });

  it('wires issued state into the server callback and consumes it before JWT processing', async () => {
    vi.stubEnv('OTTO_AUTH_URL', 'https://auth.example.test/login');
    const server = new AuthServer();
    const start = responseRecorder();

    await testSurface(server).handleStartOttoAuth(
      requestFrom('127.0.0.1', 'http://localhost:7862', 'same-origin'),
      start.response,
    );

    expect(start.record.statusCode).toBe(200);
    expect(start.record.headers.has('access-control-allow-origin')).toBe(false);
    const providerUrl = new URL(JSON.parse(start.record.body).authUrl as string);
    const state = providerUrl.searchParams.get('state');
    expect(state).toMatch(/^[a-f0-9]{64}$/);

    const firstCallback = responseRecorder();
    await testSurface(server).handleOttoCallback(callbackUrl(state!), firstCallback.response);
    expect(firstCallback.record.body).toContain('JWT');

    const replay = responseRecorder();
    await testSurface(server).handleOttoCallback(callbackUrl(state!), replay.response);
    expect(replay.record.body).toContain('失效');
  });

  it('returns 403 without wildcard CORS for a cross-site start request', async () => {
    const server = new AuthServer();
    const result = responseRecorder();

    await testSurface(server).handleStartOttoAuth(
      requestFrom('127.0.0.1', 'https://evil.example', 'cross-site'),
      result.response,
    );

    expect(result.record.statusCode).toBe(403);
    expect(result.record.headers.has('access-control-allow-origin')).toBe(false);
    expect(JSON.parse(result.record.body)).toMatchObject({ success: false });
  });
});
