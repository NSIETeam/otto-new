import { describe, expect, it, vi } from 'vitest';

import { DesktopRpaDriverV1, type DesktopRpaPortV1 } from './desktop-driver.js';
import { RpaRunner } from './runner.js';
import type { RpaRun, RpaWorkflowV1 } from './contracts.js';
import type { RpaRunStore } from './ports.js';

function port(): DesktopRpaPortV1 {
  return {
    inspect: vi.fn().mockResolvedValue({ appId: 'mail', windowTitle: 'Mail', redactedTree: {} }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    fill: vi.fn(), select: vi.fn(), scroll: vi.fn(), wait: vi.fn(),
    screenshot: vi.fn().mockResolvedValue({ bytes: new Uint8Array([1]), redactedSummary: 'redacted app window' }),
  };
}

function unusedStore(): RpaRunStore {
  return {
    create: vi.fn<() => Promise<RpaRun>>(), get: vi.fn(), save: vi.fn(),
  } as unknown as RpaRunStore;
}

describe('DesktopRpaDriverV1', () => {
  it('uses an accessibility target and passes the durable idempotency key', async () => {
    const desktop = port();
    const driver = new DesktopRpaDriverV1(desktop);
    await driver.execute({
      run: {}, idempotencyKey: 'run:step:1',
      step: {
        id: 'open', action: 'desktop.click', sideEffect: 'external', requiresApproval: true,
        args: { appId: 'com.example.mail', target: { role: 'button', name: '发送' } },
      },
    });
    expect(desktop.click).toHaveBeenCalledWith({
      appId: 'com.example.mail', target: { role: 'button', name: '发送' },
      idempotencyKey: 'run:step:1',
    });
  });

  it('rejects credential fields and never invokes the privileged port', async () => {
    const desktop = port();
    const driver = new DesktopRpaDriverV1(desktop);
    await expect(driver.execute({
      run: {}, idempotencyKey: 'run:step:1',
      step: {
        id: 'secret', action: 'desktop.fill', sideEffect: 'none',
        args: { appId: 'settings', target: { role: 'secure-text-field', name: '密码' }, value: 'secret' },
      },
    })).rejects.toThrow('credential fields');
    expect(desktop.fill).not.toHaveBeenCalled();
  });

  it('stores screenshots only as redacted evidence artifacts', async () => {
    const driver = new DesktopRpaDriverV1(port());
    await expect(driver.execute({
      run: {}, idempotencyKey: 'run:shot:1',
      step: { id: 'shot', action: 'desktop.screenshot', sideEffect: 'none', args: { appId: 'mail' } },
    })).resolves.toEqual({
      artifacts: [{ mediaType: 'image/png', bytes: new Uint8Array([1]), redactedSummary: 'redacted app window' }],
    });
  });
});

describe('desktop workflow validation', () => {
  it('rejects raw coordinates, scripts, shell, and secrets at installation time', () => {
    for (const args of [
      { appId: 'app', x: 20, y: 30 },
      { appId: 'app', script: 'document.body.click()' },
      { appId: 'app', command: 'rm file' },
      { appId: 'app', password: 'secret' },
      { appId: 'app', target: { role: 'button', name: '提交', x: 20 } },
    ]) {
      const workflow: RpaWorkflowV1 = {
        id: 'unsafe', version: 1,
        steps: [{ id: 'unsafe', action: 'desktop.click', sideEffect: 'none', args }],
      };
      expect(() => new RpaRunner([workflow], unusedStore(), {
        authorize: vi.fn(),
      }, new DesktopRpaDriverV1(port()), { put: vi.fn() })).toThrow('forbidden');
    }
  });

  it('requires external desktop effects to declare approval', () => {
    const workflow: RpaWorkflowV1 = {
      id: 'send', version: 1,
      steps: [{
        id: 'send', action: 'desktop.click', sideEffect: 'external',
        args: { appId: 'mail', target: { role: 'button', name: '发送' } },
      }],
    };
    expect(() => new RpaRunner([workflow], unusedStore(), {
      authorize: vi.fn(),
    }, new DesktopRpaDriverV1(port()), { put: vi.fn() })).toThrow('must require approval');
  });
});
