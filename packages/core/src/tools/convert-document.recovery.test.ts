/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConvertDocumentTool } from './convert-document.js';
import { createMockConfig } from '../utils/test-helpers.js';
import { executeToolCall } from '../core/nonInteractiveToolExecutor.js';
import type { ToolRegistry } from './tool-registry.js';

// No real external executables are launched in fault-injection tests.
vi.mock('child_process', async (original) => ({
  ...await original<typeof import('child_process')>(),
  exec: vi.fn((_command, _options, callback) => { callback(null, '', ''); return {}; }),
}));
vi.mock('../services/doctor.js', () => ({ DoctorService: class { async check() { return { checks: [] }; } } }));

describe('document conversion outcome and cancellation contract', () => {
  let root: string;
  let input: string;
  let output: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-convert-contract-'));
    input = path.join(root, 'input.md');
    output = path.join(root, 'output.html');
    fs.writeFileSync(input, '# Synthetic test');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const params = (input: string, output: string) => ({ input_path: input, output_path: output, output_format: 'html', engine: 'pandoc' as const });

  it.each(['absent', 'stale', 'empty'] as const)('never reports success for %s output', async (mode) => {
    if (mode === 'stale') fs.writeFileSync(output, 'old artifact');
    const runCommand = vi.fn(async (_file: string, args: string[]) => {
      if (mode === 'empty') fs.writeFileSync(args[args.indexOf('-o') + 1], '');
    });
    const tool = new ConvertDocumentTool(createMockConfig(), { runCommand, preflight: async () => null });
    await expect(tool.execute(params(input, output), new AbortController().signal)).rejects.toThrow(/output|产出/i);
    if (mode === 'stale') expect(fs.readFileSync(output, 'utf8')).toBe('old artifact');
    else expect(fs.existsSync(output)).toBe(false);
  });

  it('propagates dependency failure as executor failure, not successful text', async () => {
    const config = createMockConfig();
    const tool = new ConvertDocumentTool(config, { preflight: async () => 'pandoc unavailable' });
    const result = await executeToolCall(config, { name: tool.name, args: params(input, output), callId: 'conversion', prompt_id: 'synthetic', isClientInitiated: false }, { getTool: () => tool } as unknown as ToolRegistry);
    expect(result.error?.message).toContain('pandoc');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('does not launch an already cancelled operation', async () => {
    const runCommand = vi.fn(async () => undefined);
    const tool = new ConvertDocumentTool(createMockConfig(), { runCommand, preflight: async () => null });
    const controller = new AbortController(); controller.abort();
    await expect(tool.execute(params(input, output), controller.signal)).rejects.toThrow();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('passes cancellation and a bounded timeout; publishes only new output', async () => {
    const runCommand = vi.fn(async (_file: string, args: string[]) => { fs.writeFileSync(args[args.indexOf('-o') + 1], '<html>new</html>'); });
    const tool = new ConvertDocumentTool(createMockConfig(), { runCommand, preflight: async () => null });
    const signal = new AbortController().signal;
    await tool.execute(params(input, output), signal);
    expect(runCommand).toHaveBeenCalledWith('pandoc', expect.any(Array), expect.objectContaining({ signal, timeout: expect.any(Number) }));
    expect(fs.readFileSync(output, 'utf8')).toBe('<html>new</html>');
  });

  it('does not publish after cancellation during conversion', async () => {
    fs.writeFileSync(output, 'old artifact');
    const controller = new AbortController();
    const tool = new ConvertDocumentTool(createMockConfig(), { preflight: async () => null, runCommand: async (_file, args) => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'late result'); controller.abort();
    } });
    await expect(tool.execute(params(input, output), controller.signal)).rejects.toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe('old artifact');
  });

  it('rejects a shared batch destination instead of overwriting earlier outputs', () => {
    const second = path.join(root, 'second.md'); fs.writeFileSync(second, 'second');
    const tool = new ConvertDocumentTool(createMockConfig());
    expect(tool.validateToolParams({ input_paths: [input, second], output_format: 'html', output_path: output })).not.toBeNull();
  });
});
