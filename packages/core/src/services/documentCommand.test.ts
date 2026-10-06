/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDocumentCommand, type ExecFileImplementation } from './documentCommand.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('shared document process lifecycle', () => {
  it.each([new Error('spawn denied'), 'spawn denied'])('rejects synchronous process-launch failure: %s', async (failure) => {
    await expect(runDocumentCommand('synthetic', [], { execFileImpl: () => { throw failure; } })).rejects.toThrow('spawn denied');
  });

  it('settles cancellation without an exit callback even when killing races with exit', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const assertion = expect(runDocumentCommand('synthetic', [], {
      platform: 'linux', signal: controller.signal,
      execFileImpl: () => ({ kill: () => { throw new Error('already exited'); } }),
    })).rejects.toThrow(/cancel/i);
    controller.abort('cancelled');
    await vi.advanceTimersByTimeAsync(1600);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not spawn after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const execFileImpl = vi.fn<ExecFileImplementation>((_file, _args, _options, callback) => callback(null, '', ''));
    await expect(runDocumentCommand('synthetic', [], { signal: controller.signal, execFileImpl })).rejects.toThrow();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('cancellation wins over a late zero exit and requests process termination', async () => {
    const controller = new AbortController();
    let callback!: Parameters<ExecFileImplementation>[3];
    const kill = vi.fn(() => true);
    const promise = runDocumentCommand('synthetic', [], {
      signal: controller.signal,
      execFileImpl: (_file, _args, _options, cb) => { callback = cb; return { kill }; },
    });
    const assertion = expect(promise).rejects.toThrow();
    controller.abort();
    callback(null, '', '');
    await assertion;
    expect(kill).toHaveBeenCalled();
  });

  it('timeout wins over a late zero exit', async () => {
    vi.useFakeTimers();
    let callback!: Parameters<ExecFileImplementation>[3];
    const kill = vi.fn(() => true);
    const promise = runDocumentCommand('synthetic', [], {
      timeout: 20,
      execFileImpl: (_file, _args, _options, cb) => { callback = cb; return { kill }; },
    });
    const assertion = expect(promise).rejects.toThrow(/timeout|超时/i);
    await vi.advanceTimersByTimeAsync(25);
    callback(null, '', '');
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(kill).toHaveBeenCalled();
  });

  it('really terminates a running synthetic Node child on cancellation', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await expect(runDocumentCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeout: 2_000 })).rejects.toThrow();
    } finally { clearTimeout(timer); }
  });

  it('finishes POSIX tree termination even when the launcher exits first', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    let callback!: Parameters<ExecFileImplementation>[3];
    const controller = new AbortController();
    const assertion = expect(runDocumentCommand('synthetic', [], {
      platform: 'linux', signal: controller.signal,
      execFileImpl: (_file, _args, options, cb) => {
        expect(options.detached).toBe(true); callback = cb; return { pid: 12345 };
      },
    })).rejects.toThrow();
    controller.abort(); callback(null, '', '');
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  });
});
