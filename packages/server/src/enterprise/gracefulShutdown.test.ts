/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { shutdownEnterpriseRuntime } from './gracefulShutdown.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('enterprise direct launcher graceful shutdown', () => {
  it('closes SQLite only after the wrapped server drain succeeds', async () => {
    const events: string[] = [];
    const server = {
      close: (callback: (error?: Error) => void) => {
        events.push('close-start');
        callback();
        return server;
      },
      closeAllConnections: vi.fn(),
    };
    await shutdownEnterpriseRuntime({
      server,
      closeDatabase: () => {
        events.push('db-close');
      },
      forceShutdownTimeoutMs: 45_000,
    });
    expect(events).toEqual(['close-start', 'db-close']);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it('keeps SQLite open after drain failure until the outer watchdog hard-exits', async () => {
    vi.useFakeTimers();
    const closeDatabase = vi.fn();
    const errors: Error[] = [];
    const hardExit = vi.fn();
    const server = {
      close: (callback: (error?: Error) => void) => {
        callback(new Error('completion checkpoint pending'));
        return server;
      },
      closeAllConnections: vi.fn(),
    };
    const shutdown = shutdownEnterpriseRuntime(
      { server, closeDatabase, forceShutdownTimeoutMs: 45_000 },
      { hardExit, onError: (error) => errors.push(error) },
    );
    const assertion = expect(shutdown).rejects.toThrow(/exceeded 45000ms/u);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    expect(hardExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(hardExit).toHaveBeenCalledWith(1);
    expect(errors.map((error) => error.message)).toEqual([
      'completion checkpoint pending',
      'enterprise graceful shutdown exceeded 45000ms',
    ]);
  });
});
