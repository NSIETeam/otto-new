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

  it('rejects colliding default batch names before launching any commands', async () => {
    const second = path.join(root, 'input.txt'); fs.writeFileSync(second, 'second');
    const runCommand = vi.fn(async (_file: string, args: string[]) => fs.writeFileSync(args[args.indexOf('-o') + 1], 'converted'));
    const tool = new ConvertDocumentTool(createMockConfig(), { runCommand, preflight: async () => null });
    await expect(tool.execute({ input_paths: [input, second], output_format: 'html', engine: 'pandoc' }, new AbortController().signal)).rejects.toThrow(/collision|same|同名/i);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(['-o other.html', '--output=other.html', '--outdir elsewhere', '--convert-to pdf', '-env:UserInstallation=file:///elsewhere', '--toc; echo unsafe'])('rejects output overrides and shell operators: %s', (options) => {
    expect(new ConvertDocumentTool(createMockConfig()).validateToolParams({ ...params(input, output), options })).not.toBeNull();
  });

  it('reports a partially completed batch as failure and cleans its staging', async () => {
    const second = path.join(root, 'second.md'); fs.writeFileSync(second, 'second');
    let calls = 0;
    const tool = new ConvertDocumentTool(createMockConfig(), { preflight: async () => null, runCommand: async (_file, args) => {
      if (++calls === 2) throw new Error('synthetic renderer failed');
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'first converted');
    } });
    await expect(tool.execute({ input_paths: [input, second], output_format: 'html', engine: 'pandoc' }, new AbortController().signal)).rejects.toThrow('1/2 files converted');
    expect(fs.readFileSync(path.join(root, 'input.html'), 'utf8')).toBe('first converted');
    expect(fs.readdirSync(root).filter(file => file.startsWith('.otto-convert-'))).toEqual([]);
  });

  it('isolates LibreOffice and commits its generated basename to the requested name', async () => {
    const officeInput = path.join(root, 'report.docx'); fs.writeFileSync(officeInput, 'synthetic office');
    const tool = new ConvertDocumentTool(createMockConfig(), { preflight: async () => null, runCommand: async (_file, args) => {
      expect(args[0]).toMatch(/^-env:UserInstallation=file:/);
      fs.writeFileSync(path.join(args[args.indexOf('--outdir') + 1], 'report.html'), 'new office result');
    } });
    await tool.execute({ input_path: officeInput, output_path: output, output_format: 'html' }, new AbortController().signal);
    expect(fs.readFileSync(output, 'utf8')).toBe('new office result');
  });

  it.each([false, true])('requires new compression output (missing=%s)', async (missing) => {
    const pdf = path.join(root, 'input.pdf'); fs.writeFileSync(pdf, 'original PDF');
    const tool = new ConvertDocumentTool(createMockConfig(), { preflight: async () => null, runCommand: async (_file, args) => {
      if (!missing) fs.writeFileSync(args.find(arg => arg.startsWith('-sOutputFile='))!.slice('-sOutputFile='.length), 'compressed PDF');
    } });
    const result = tool.execute({ input_path: pdf, output_format: 'pdf', compress: 2 }, new AbortController().signal);
    if (missing) await expect(result).rejects.toThrow(/output/); else await result;
    expect(fs.readFileSync(pdf, 'utf8')).toBe(missing ? 'original PDF' : 'compressed PDF');
  });

  it.each([false, true])('merges PDF/mixed sources through staged argv commands (mixed=%s)', async (mixed) => {
    const a = path.join(root, 'a.pdf'); const b = path.join(root, mixed ? 'b.md' : 'b.pdf');
    fs.writeFileSync(a, 'first'); fs.writeFileSync(b, 'second');
    const tool = new ConvertDocumentTool(createMockConfig(), { preflight: async () => null, runCommand: async (file, args) => {
      if (file === 'where' || file === 'which') return;
      const target = file === 'pdfunite' ? args.at(-1)! : args[args.indexOf('-o') + 1];
      fs.writeFileSync(target, 'synthetic merged output');
    } });
    await tool.execute({ input_paths: [a, b], merge: true, output_format: 'pdf', output_path: output, engine: 'pandoc' }, new AbortController().signal);
    expect(fs.readFileSync(output, 'utf8')).toBe('synthetic merged output');
    expect(fs.readdirSync(root).filter(file => file.startsWith('.otto-convert-'))).toEqual([]);
  });

  it('fails PDF merge cleanly when the merge executable is missing', async () => {
    const a = path.join(root, 'a.pdf'); const b = path.join(root, 'b.pdf');
    fs.writeFileSync(a, 'first'); fs.writeFileSync(b, 'second'); fs.writeFileSync(output, 'old artifact');
    const tool = new ConvertDocumentTool(createMockConfig(), { runCommand: async () => { throw new Error('executable unavailable'); } });
    await expect(tool.execute({ input_paths: [a, b], merge: true, output_format: 'pdf', output_path: output }, new AbortController().signal)).rejects.toThrow('pdfunite');
    expect(fs.readFileSync(output, 'utf8')).toBe('old artifact');
    expect(fs.readdirSync(root).filter(file => file.startsWith('.otto-convert-'))).toEqual([]);
  });
});
