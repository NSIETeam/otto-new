import { describe, expect, it, vi } from 'vitest';
import { InMemoryRecurringTaskStateStore } from 'otto-core';

import { OttoServer } from './server.js';

function createServer(): OttoServer {
  return new OttoServer({
    port: 0,
    mock: true,
    recurringTaskStateStore: new InMemoryRecurringTaskStateStore(),
  });
}

function configureMaintenance(server: OttoServer, paid: boolean): void {
  const internal = server as unknown as {
    startResidentMaintenanceTasks(enabled: boolean): void;
  };
  internal.startResidentMaintenanceTasks(paid);
}

function toggleCompression(server: OttoServer, enabled: boolean): void {
  const internal = server as unknown as {
    setAutoCompressionEnabled(enabled: boolean): void;
  };
  internal.setAutoCompressionEnabled(enabled);
}

describe('OttoServer resident task registration', () => {
  it('registers only deterministic local maintenance by default', () => {
    const server = createServer();
    configureMaintenance(server, false);

    expect(server.residentTasks()).toMatchObject([{
      name: 'server-local-memory-maintenance',
      source: 'packages/server/src/server.ts#memory-maintenance',
      estimatedCostUsdPerRun: 0,
      paid: false,
      running: false,
    }]);
  });

  it('registers paid compression only after explicit opt-in and stops it immediately', () => {
    const server = createServer();
    configureMaintenance(server, false);
    expect(server.residentTasks().some((task) => task.paid)).toBe(false);

    toggleCompression(server, true);
    expect(server.residentTasks().find((task) => task.paid)).toMatchObject({
      name: 'server-background-context-compression',
      estimatedCostUsdPerRun: 0.01,
    });

    toggleCompression(server, false);
    expect(server.residentTasks().some((task) => task.paid)).toBe(false);
  });

  it('does not duplicate registrations when the same setting is applied again', () => {
    const server = createServer();
    configureMaintenance(server, true);
    configureMaintenance(server, true);
    toggleCompression(server, true);

    expect(server.residentTasks().map((task) => task.name)).toEqual([
      'server-local-memory-maintenance',
      'server-background-context-compression',
    ]);
  });

  it('keeps the paid task inert when no compressible session input exists', async () => {
    vi.useFakeTimers();
    const server = createServer();
    // Register only the paid task: advancing fake time must never invoke the
    // real global memory engine or touch a developer's user data.
    toggleCompression(server, true);
    const paid = server.residentTasks().find((task) => task.paid);
    expect(paid?.inputVersion).toBeUndefined();
    await vi.advanceTimersByTimeAsync(paid?.intervalMs ?? 0);
    expect(server.residentTasks().find((task) => task.paid)?.lastCompletedInputVersion)
      .toBeUndefined();
    vi.useRealTimers();
  });
});
