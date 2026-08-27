/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { startManagedDurableWorkflowWorkerRuntime } from './workerCli.js';

describe('durable workflow Worker process lifecycle', () => {
  it('closes the Worker and database when health binding fails', async () => {
    const initializeDatabase = vi.fn().mockResolvedValue(undefined);
    const startWorker = vi.fn().mockResolvedValue(undefined);
    const closeHealth = vi.fn().mockResolvedValue(undefined);
    const closeWorker = vi.fn().mockResolvedValue(undefined);
    const closeDatabase = vi.fn().mockResolvedValue(undefined);

    await expect(
      startManagedDurableWorkflowWorkerRuntime({
        initializeDatabase,
        startWorker,
        listenHealth: vi.fn().mockRejectedValue(new Error('EADDRINUSE')),
        closeHealth,
        closeWorker,
        closeDatabase,
      }),
    ).rejects.toThrow('EADDRINUSE');

    expect(initializeDatabase).toHaveBeenCalledOnce();
    expect(startWorker).toHaveBeenCalledOnce();
    expect(closeHealth).toHaveBeenCalledOnce();
    expect(closeWorker).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('makes normal process shutdown idempotent', async () => {
    const closeHealth = vi.fn().mockResolvedValue(undefined);
    const closeWorker = vi.fn().mockResolvedValue(undefined);
    const closeDatabase = vi.fn().mockResolvedValue(undefined);
    const runtime = await startManagedDurableWorkflowWorkerRuntime({
      initializeDatabase: vi.fn().mockResolvedValue(undefined),
      startWorker: vi.fn().mockResolvedValue(undefined),
      listenHealth: vi.fn().mockResolvedValue(undefined),
      closeHealth,
      closeWorker,
      closeDatabase,
    });

    await Promise.all([runtime.close(), runtime.close()]);

    expect(closeHealth).toHaveBeenCalledOnce();
    expect(closeWorker).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
