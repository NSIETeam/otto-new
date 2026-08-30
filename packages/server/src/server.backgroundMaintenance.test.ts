/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryRecurringTaskStateStore } from 'otto-core';
import { afterEach, describe, expect, it } from 'vitest';
import { OttoServer } from './server.js';
import { ProductWorkspaceStore } from './productWorkspaceStore.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('OttoServer background maintenance load', () => {
  it('does not register paid background work until explicitly enabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-maintenance-'));
    roots.push(root);
    const server = new OttoServer({
      port: 0,
      mock: true,
      productWorkspaceStore: new ProductWorkspaceStore({ rootDir: root }),
      recurringTaskStateStore: new InMemoryRecurringTaskStateStore(),
    });
    const maintenance = server as unknown as {
      startResidentMaintenanceTasks: (enabled: boolean) => void;
      setAutoCompressionEnabled: (enabled: boolean) => void;
    };
    maintenance.startResidentMaintenanceTasks(false);
    expect(server.residentTasks().some((task) => task.paid)).toBe(false);

    maintenance.setAutoCompressionEnabled(true);
    expect(server.residentTasks().filter((task) => task.paid)).toEqual([
      expect.objectContaining({
        name: 'server-background-context-compression',
      }),
    ]);
    maintenance.setAutoCompressionEnabled(false);
    expect(server.residentTasks().some((task) => task.paid)).toBe(false);
    await server.stop();
  });
});
