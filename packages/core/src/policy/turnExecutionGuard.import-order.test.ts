/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';

const entryPoints = [
  ['directory tool', async () => (await import('../tools/ls.js')).LSTool],
  ['edit tool', async () => (await import('../tools/edit.js')).EditTool],
  [
    'write tool',
    async () => (await import('../tools/write-file.js')).WriteFileTool,
  ],
  [
    'multi-file reader',
    async () => (await import('../tools/read-many-files.js')).ReadManyFilesTool,
  ],
  [
    'prompt builder',
    async () => (await import('../core/prompts.js')).getCoreSystemPrompt,
  ],
] as const;

it.each(entryPoints)(
  'initializes %s before the execution guard',
  async (_name, loadEntryPoint) => {
    vi.resetModules();
    expect(await loadEntryPoint()).toBeTypeOf('function');
    const { installTurnExecutionGuard, assertTurnExecutionAllowed } =
      await import('./turnExecutionGuard.js');
    const config = {};
    const denyNonNative = vi.fn((call) => {
      if (!call.nativeSafe) throw new Error('native identity required');
    });
    const release = installTurnExecutionGuard(config, denyNonNative);
    try {
      expect(() =>
        assertTurnExecutionAllowed(
          config,
          {
            callId: 'impostor',
            name: 'write_file',
            args: {},
          },
          { execute() {} },
        ),
      ).toThrow('native identity required');
      expect(denyNonNative).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    // Each case intentionally initializes the complete cold tool/config graph under
    // coverage. Keep a bounded import budget without changing any runtime deadline.
  },
  30_000,
);
