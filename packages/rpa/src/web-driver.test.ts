/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { RunScopedWebDriver, type RpaWebSession } from './web-driver.js';
import type { RpaDriver } from './ports.js';

function input(action: Parameters<RpaDriver['execute']>[0]['step']['action'], args: Record<string, unknown>): Parameters<RpaDriver['execute']>[0] {
  return {
    run: { id: 'rpa-run-1', workflow: { allowedHosts: ['example.com', 'unlisted.example', 'localhost', '127.0.0.1', '10.0.0.8', '100.64.0.1', '169.254.169.254', '192.168.1.2', '172.16.0.1'] } } as unknown as Parameters<RpaDriver['execute']>[0]['run'],
    step: { action, args } as Parameters<RpaDriver['execute']>[0]['step'],
    idempotencyKey: 'rpa-run-1:step:1',
  };
}

describe('RunScopedWebDriver', () => {
  it('reuses one browser session for every action in a run and records screenshots as artifacts', async () => {
    const session: RpaWebSession = {
      page: {
        goto: vi.fn(), fill: vi.fn(), click: vi.fn(), textContent: vi.fn(), route: vi.fn(),
        screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), waitForSelector: vi.fn(),
      },
      close: vi.fn(),
    };
    const factory = { create: vi.fn().mockResolvedValue(session) };
    const driver = new RunScopedWebDriver(factory, { authorize: async () => {} });

    await driver.execute(input('web.navigate', { url: 'https://example.com' }));
    const screenshot = await driver.execute(input('web.screenshot', {}));

    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(screenshot.artifacts?.[0]).toMatchObject({ mediaType: 'image/png', redactedSummary: 'RPA page screenshot' });
    await driver.closeRun('rpa-run-1');
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('installs a request guard that aborts redirected or subresource requests outside declared hosts', async () => {
    let guard: ((route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => Promise<void>) | undefined;
    const page = {
      goto: vi.fn(), fill: vi.fn(), click: vi.fn(), textContent: vi.fn(), screenshot: vi.fn(), waitForSelector: vi.fn(),
      route: vi.fn().mockImplementation(async (_pattern, handler) => { guard = handler; }),
    };
    const driver = new RunScopedWebDriver({ create: vi.fn().mockResolvedValue({ page, close: vi.fn() }) }, { authorize: async () => {} });
    await driver.execute(input('web.navigate', { url: 'https://example.com' }));
    const blocked = { request: () => ({ url: () => 'https://tracker.example/script.js' }), continue: vi.fn(), abort: vi.fn() };

    await guard!(blocked);

    expect(blocked.abort).toHaveBeenCalledTimes(1);
    expect(blocked.continue).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing navigation URLs before reaching the browser', async () => {
    const factory = { create: vi.fn() };
    const driver = new RunScopedWebDriver(factory);

    await expect(driver.execute(input('web.navigate', { url: 'https://user:secret@example.com' }))).rejects.toThrow('credential-free');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it.each([
    'http://localhost/admin',
    'http://127.0.0.1/internal',
    'http://10.0.0.8/',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.2/',
    'http://172.16.0.1/',
    'http://100.64.0.1/',
  ])('rejects local or private navigation target %s', async (url) => {
    const factory = { create: vi.fn() };
    const driver = new RunScopedWebDriver(factory);

    await expect(driver.execute(input('web.navigate', { url }))).rejects.toThrow('private network');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('enforces an injected deployment domain policy before creating a session', async () => {
    const factory = { create: vi.fn() };
    const authorize = vi.fn().mockRejectedValue(new Error('domain is not declared'));
    const driver = new RunScopedWebDriver(factory, { authorize });

    await expect(driver.execute(input('web.navigate', { url: 'https://unlisted.example' }))).rejects.toThrow('not declared');
    expect(authorize).toHaveBeenCalledWith(new URL('https://unlisted.example'));
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('rejects a public host that is absent from the workflow declaration', async () => {
    const factory = { create: vi.fn() };
    const driver = new RunScopedWebDriver(factory, { authorize: vi.fn() });
    const request = input('web.navigate', { url: 'https://other.example' });

    await expect(driver.execute(request)).rejects.toThrow('domain is not declared');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('fails closed when a resumed run lacks its original browser context', async () => {
    const factory = { create: vi.fn() };
    const driver = new RunScopedWebDriver(factory);

    await expect(driver.execute(input('web.fill', { selector: '#amount', value: '100' }))).rejects.toThrow('browser context is unavailable');
    expect(factory.create).not.toHaveBeenCalled();
  });
});
