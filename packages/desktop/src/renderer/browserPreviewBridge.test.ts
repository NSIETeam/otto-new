// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('browserPreviewBridge', () => {
  afterEach(() => {
    delete (window as unknown as { otto?: unknown }).otto;
    vi.resetModules();
  });

  it('returns arrays for customer module collections instead of the generic null fallback', async () => {
    delete (window as unknown as { otto?: unknown }).otto;
    await import('./browserPreviewBridge.js');
    const bridge = (window as unknown as {
      otto: {
        customerModuleList(): Promise<unknown[]>;
        customerModuleInstalledList(): Promise<unknown[]>;
      };
    }).otto;

    await expect(bridge.customerModuleList()).resolves.toEqual([]);
    await expect(bridge.customerModuleInstalledList()).resolves.toEqual([]);
  });

  it('responds to settings panel requests with usable preview frames', async () => {
    delete (window as unknown as { otto?: unknown }).otto;
    await import('./browserPreviewBridge.js');
    const bridge = (window as unknown as {
      otto: {
        onFrame(handler: (frame: { type: string; payload: unknown }) => void): () => void;
        send(frame: { type: string; payload: Record<string, unknown> }): void;
      };
    }).otto;
    const received: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = bridge.onFrame((frame) => received.push(frame));

    for (const type of [
      'get_settings',
      'get_search_config',
      'mcp_list',
      'get_context_breakdown',
      'run_doctor',
      'get_todos',
      'get_memory',
      'get_skills',
      'get_tools',
      'get_workflows',
      'get_extensions',
      'get_ide_status',
      'get_stats',
      'get_knowledge',
    ]) {
      bridge.send({ type, payload: { sessionId: 'preview-session' } });
    }

    expect(received.map((frame) => frame.type)).toEqual([
      'settings',
      'search_config',
      'mcp_servers',
      'context_breakdown',
      'doctor_report',
      'todos_list',
      'memory_snapshot',
      'skills_list',
      'tools_list',
      'workflows_list',
      'extensions_list',
      'ide_status',
      'stats_snapshot',
      'knowledge_data',
    ]);
    expect(received[0]?.payload).toMatchObject({
      healthyUse: true,
      backgroundModelTasksEnabled: false,
    });
    unsubscribe();
  });
});
