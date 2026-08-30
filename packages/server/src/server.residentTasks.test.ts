import { describe, expect, it, vi } from 'vitest';
import { InMemoryRecurringTaskStateStore } from 'otto-core';

import { OttoServer } from './server.js';
import type { ResidentWorkflowSupervisor } from 'otto-workflow';
import type { ManagedChannelPlatformV1 } from './modules/integration_adapters/managedChannelPlatform.js';

function createServer(
  residentWorkflowSupervisor?: ResidentWorkflowSupervisor,
  managedChannelPlatform?: ManagedChannelPlatformV1,
): OttoServer {
  return new OttoServer({
    port: 0,
    mock: true,
    recurringTaskStateStore: new InMemoryRecurringTaskStateStore(),
    residentWorkflowSupervisor,
    managedChannelPlatform,
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

  it('registers one non-overlapping durable workflow worker and skips unchanged revisions', async () => {
    vi.useFakeTimers();
    let inputVersion: string | undefined = 'wf-1:1';
    const tick = vi.fn(async () => []);
    const supervisor = {
      inputVersion: vi.fn(async () => inputVersion),
      tick,
    } as unknown as ResidentWorkflowSupervisor;
    const server = createServer(supervisor);
    configureMaintenance(server, false);
    expect(server.residentTasks()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'server-durable-workflow-worker',
        source: 'packages/server/src/server.ts#resident-workflow',
        paid: false,
        intervalMs: 1_000,
      }),
    ]));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledOnce();
    inputVersion = 'wf-1:2';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    await server.stop();
    vi.useRealTimers();
  });

  it('registers zero-cost channel milestones and skips unchanged workflow state', async () => {
    vi.useFakeTimers();
    let inputVersion = 'wf-1:running:1';
    const flushMilestones = vi.fn(async () => undefined);
    const platform = {
      connectors: {},
      milestoneInputVersion: vi.fn(async () => inputVersion),
      flushMilestones,
      stopAll: vi.fn(async () => undefined),
    } as unknown as ManagedChannelPlatformV1;
    const server = createServer(undefined, platform);
    configureMaintenance(server, false);

    expect(server.residentTasks()).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'server-channel-workflow-milestones',
      source: 'packages/server/src/server.ts#channel-workflow-milestones',
      estimatedCostUsdPerRun: 0,
      paid: false,
      intervalMs: 2_000,
    })]));
    await vi.advanceTimersByTimeAsync(0);
    expect(flushMilestones).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flushMilestones).toHaveBeenCalledOnce();
    inputVersion = 'wf-1:succeeded:2';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flushMilestones).toHaveBeenCalledTimes(2);
    await server.stop();
    vi.useRealTimers();
  });
});
