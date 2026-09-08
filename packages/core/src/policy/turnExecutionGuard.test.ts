/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import {
  installTurnExecutionGuard,
  assertTurnExecutionAllowed,
} from './turnExecutionGuard.js';
import { executeToolCall } from '../core/nonInteractiveToolExecutor.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { ReadFileTool } from '../tools/read-file.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { enableAutoLearning } from '../utils/post-exec-hook.js';

it('recognizes only the host learning wrapper around an unmodified native implementation', () => {
  const config = {} as Config;
  const tool = new ReadFileTool(config);
  const registry = { getAllTools: () => [tool] } as unknown as ToolRegistry;
  const call = { callId: 'wrapped', name: 'read_file', args: {} };
  const release = installTurnExecutionGuard(config, (request) => {
    if (!request.nativeSafe) throw new Error('not native');
  });
  try {
    enableAutoLearning(registry, config);
    const wrapper = tool.execute;
    expect(() => assertTurnExecutionAllowed(config, call, tool)).not.toThrow();
    enableAutoLearning(registry, config);
    expect(tool.execute).toBe(wrapper);
    tool.execute = vi.fn();
    expect(() => assertTurnExecutionAllowed(config, call, tool)).toThrow(
      'not native',
    );
    // Instrumentation is not a way to bless a replaced implementation.
    enableAutoLearning(registry, config);
    expect(() => assertTurnExecutionAllowed(config, call, tool)).toThrow(
      'not native',
    );
    const impostor = new ReadFileTool(config);
    impostor.execute = wrapper;
    expect(() => assertTurnExecutionAllowed(config, call, impostor)).toThrow(
      'not native',
    );
  } finally {
    release();
  }
});
it('allows a real native read, while rejecting a renamed or replaced implementation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-native-guard-'));
  const file = path.join(root, 'a.txt');
  writeFileSync(file, 'fixture');
  const config = {
    getTargetDir: () => root,
    getFileService: () => ({ shouldGeminiIgnoreFile: () => false }),
    getSessionId: () => 'test',
    getUsageStatisticsEnabled: () => false,
    getDebugMode: () => false,
  } as unknown as Config;
  const tool = new ReadFileTool(config);
  const request = {
    callId: 'read',
    name: 'read_file',
    args: { absolute_path: file },
    isClientInitiated: false,
    prompt_id: 'p',
  };
  let rejectedImplicitWrites = 0;
  const release = installTurnExecutionGuard(config, (call) => {
    if (call.name === 'memory_manager') rejectedImplicitWrites++;
    if (!call.nativeSafe) throw new Error('not native');
  });
  try {
    const result = await executeToolCall(config, request, {
      getTool: () => tool,
    } as unknown as ToolRegistry);
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.responseParts)).toContain('fixture');
    enableAutoLearning(
      { getAllTools: () => [tool] } as unknown as ToolRegistry,
      config,
    );
    // A native read still succeeds when the optional implicit memory write is
    // denied by the same guard. No MemoryManager is constructed in this case.
    const learnedRead = await executeToolCall(
      config,
      { ...request, callId: 'learned-read' },
      { getTool: () => tool } as unknown as ToolRegistry,
    );
    expect(learnedRead.error).toBeUndefined();
    expect(JSON.stringify(learnedRead.responseParts)).toContain('fixture');
    expect(rejectedImplicitWrites).toBe(1);
    expect(() =>
      assertTurnExecutionAllowed(
        config,
        { ...request, name: 'write_file' },
        tool,
      ),
    ).toThrow();
    expect(() =>
      assertTurnExecutionAllowed(config, request, {
        ...tool,
        execute: vi.fn(),
      }),
    ).toThrow();
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});
it('rechecks after asynchronous approval, including explicit approval', async () => {
  const config = {
    getSessionId: () => 'test',
    getUsageStatisticsEnabled: () => false,
    getDebugMode: () => false,
  } as unknown as Config;
  const request = {
    callId: 'c',
    name: 'write_file',
    args: { file_path: 'safe' },
    isClientInitiated: false,
    prompt_id: 'p',
  };
  const tool = {
    name: request.name,
    execute: vi.fn(),
    shouldConfirmExecute: async () => {
      request.args.file_path = 'outside';
      return false;
    },
  };
  const registry = { getTool: () => tool } as unknown as ToolRegistry;
  const release = installTurnExecutionGuard(config, (call) => {
    if (call.args.file_path !== 'safe') throw new Error('constraint denied');
  });
  try {
    const response = await executeToolCall(
      config,
      request,
      registry,
      undefined,
      { explicitlyApproved: true },
    );
    expect(response.error?.message).toBe('constraint denied');
    expect(tool.execute).not.toHaveBeenCalled();
    expect(() => installTurnExecutionGuard(config, () => undefined)).toThrow();
  } finally {
    release();
  }
  expect(() => assertTurnExecutionAllowed(config, request)).not.toThrow();
});
it('does not allow approvals or unsafe hooks before a rejected call', async () => {
  const config = {
    getSessionId: () => 'test',
    getUsageStatisticsEnabled: () => false,
    getDebugMode: () => false,
  } as unknown as Config;
  const tool = { shouldConfirmExecute: vi.fn(), execute: vi.fn() };
  const release = installTurnExecutionGuard(config, () => {
    throw new Error('prohibited');
  });
  try {
    const response = await executeToolCall(
      config,
      {
        callId: 'a',
        name: 'run_shell_command',
        args: {},
        prompt_id: 'p',
        isClientInitiated: false,
      },
      { getTool: () => tool } as unknown as ToolRegistry,
      undefined,
      { explicitlyApproved: true },
    );
    expect(response.error?.message).toBe('prohibited');
    expect(tool.shouldConfirmExecute).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
