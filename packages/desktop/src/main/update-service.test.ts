/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  openPath: vi.fn(),
  quit: vi.fn(),
  exists: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { quit: mocks.quit },
  shell: { openPath: mocks.openPath },
}));
vi.mock('node:child_process', () => {
  const api = { spawn: mocks.spawn, execFile: vi.fn() };
  return { ...api, default: api };
});
vi.mock('node:fs', () => ({
  existsSync: mocks.exists,
  default: { existsSync: mocks.exists },
}));
vi.mock('./update-verify.js', () => ({
  verifyBeforeInstall: mocks.verify,
  computeFileSha256: vi.fn(),
}));
vi.mock('./update-download.js', () => ({ downloadToFile: vi.fn() }));

import { UpdateService } from './update-service.js';

class InstallerProcess extends EventEmitter {
  unref = vi.fn();
  kill = vi.fn();
}

const installerPath = 'C:\\Downloads\\Otto Setup & approved.exe';
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function downloadedService() {
  const service = new UpdateService(() => undefined, 'update-progress');
  // Download completion is a fixture here; the real install entry point must
  // still reverify these bytes before attempting either launch path.
  Object.assign(service, {
    readyFile: {
      filePath: installerPath,
      version: '1.9.15',
      sha256: 'a'.repeat(64),
    },
  });
  return service;
}

describe('Windows update installer launch lifecycle', () => {
  let child: InstallerProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    Object.defineProperty(process, 'platform', {
      ...originalPlatform,
      value: 'win32',
    });
    child = new InstallerProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.exists.mockReturnValue(true);
    mocks.verify.mockResolvedValue({ ok: true });
    mocks.openPath.mockResolvedValue('');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('does not report success, unref or quit merely because spawn returned a child', async () => {
    const settled = vi.fn();
    const pending = downloadedService().installUpdate().then(settled);
    await vi.advanceTimersByTimeAsync(401);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.verify).toHaveBeenCalledWith(installerPath, 'a'.repeat(64));
    expect(settled).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(400);
    await pending;
  });

  it('waits for real spawn acknowledgement and keeps shell arguments isolated', async () => {
    const pending = downloadedService().installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    child.emit('spawn');
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      installerPath,
      ['/S', '--force-run'],
      {
        detached: true,
        stdio: 'ignore',
        shell: false,
      },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(mocks.openPath).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.quit).toHaveBeenCalledOnce();
    child.emit('close', 0);
    expect(child.listenerCount('spawn')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('consumes asynchronous EACCES and falls back without quitting Otto', async () => {
    const pending = downloadedService().installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(() =>
      child.emit(
        'error',
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      ),
    ).not.toThrow();
    child.emit('close', -1);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('按向导'),
    });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mocks.openPath).toHaveBeenCalledExactlyOnceWith(installerPath);
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
    expect(child.listenerCount('error')).toBe(0);
  });

  it('retains the manual fallback for synchronous spawn failure', async () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error('invalid executable');
    });
    await expect(downloadedService().installUpdate()).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('按向导'),
    });
    expect(mocks.openPath).toHaveBeenCalledExactlyOnceWith(installerPath);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it('reports both launch paths failing and permits a new explicit attempt', async () => {
    const service = downloadedService();
    mocks.openPath.mockResolvedValue('access denied');
    const failed = service.installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
    child.emit('close', -1);
    await expect(failed).resolves.toEqual({
      ok: false,
      message: '打开安装包失败：access denied',
    });
    const retryChild = new InstallerProcess();
    mocks.spawn.mockReturnValue(retryChild);
    const retried = service.installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    retryChild.emit('spawn');
    await vi.advanceTimersByTimeAsync(400);
    await expect(retried).resolves.toMatchObject({ ok: true });
  });

  it('converts rejected manual open into a useful failed result', async () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error('launch denied');
    });
    mocks.openPath.mockRejectedValue(new Error('blocked by Windows'));
    await expect(downloadedService().installUpdate()).resolves.toEqual({
      ok: false,
      message: '打开安装包失败：blocked by Windows',
    });
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it.each([new Error(''), ''])(
    'does not turn an empty manual-open rejection into success: %j',
    async (error) => {
      mocks.spawn.mockImplementation(() => {
        throw new Error('launch denied');
      });
      mocks.openPath.mockRejectedValue(error);
      await expect(downloadedService().installUpdate()).resolves.toEqual({
        ok: false,
        message: '打开安装包失败：系统未提供错误详情',
      });
      expect(mocks.quit).not.toHaveBeenCalled();
    },
  );

  it('settles repeated error notifications once and removes listeners on close', async () => {
    const pending = downloadedService().installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    child.emit('error', new Error('first error'));
    expect(() => child.emit('error', new Error('second error'))).not.toThrow();
    await pending;
    expect(mocks.openPath).toHaveBeenCalledOnce();
    child.emit('close', -1);
    expect(child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats close before startup acknowledgement as failure, not an indefinite wait', async () => {
    const pending = downloadedService().installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    child.emit('close', -1);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('按向导'),
    });
    expect(child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it('handles a real Node OS-level async launch error without starting an installer', async () => {
    vi.useRealTimers();
    const { spawn: nativeSpawn } =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const nativeOs = await vi.importActual<typeof import('node:os')>('node:os');
    const nativePath =
      await vi.importActual<typeof import('node:path')>('node:path');
    const mockedPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    )!;
    let temporaryDirectory: string;
    Object.defineProperty(process, 'platform', originalPlatform);
    try {
      temporaryDirectory = nativeFs.mkdtempSync(
        nativePath.join(nativeOs.tmpdir(), 'otto-updater-spawn-'),
      );
    } finally {
      Object.defineProperty(process, 'platform', mockedPlatform);
    }
    // A fresh real directory gives ENOENT rather than a platform-dependent
    // synchronous ENOTDIR. No installer executable is created or launched.
    const absentExecutable = nativePath.join(
      temporaryDirectory,
      'otto-missing-update-installer.exe',
    );
    const nativeError = vi.fn();
    mocks.spawn.mockImplementation((_file, args, options) => {
      Object.defineProperty(process, 'platform', originalPlatform);
      try {
        const nativeChild = nativeSpawn(absentExecutable, args, options);
        nativeChild.once('error', nativeError);
        return nativeChild;
      } finally {
        Object.defineProperty(process, 'platform', mockedPlatform);
      }
    });
    try {
      expect(nativeFs.existsSync(absentExecutable)).toBe(false);
      await expect(downloadedService().installUpdate()).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining('按向导'),
      });
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.openPath).toHaveBeenCalledOnce();
      expect(mocks.quit).not.toHaveBeenCalled();
      expect(nativeError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: 'ENOENT' }),
      );
    } finally {
      nativeFs.rmdirSync(temporaryDirectory);
    }
  });

  it.each(['spawn', 'error'] as const)(
    'does not replay or quit after an unknown timeout followed by late %s',
    async (event) => {
      const service = downloadedService();
      const pending = service.installUpdate();
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining('未确认'),
      });
      expect(() => child.emit(event, new Error('late failure'))).not.toThrow();
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(service.installUpdate()).resolves.toEqual(result);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.openPath).not.toHaveBeenCalled();
      expect(mocks.quit).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      child.emit('close', 0);
      expect(child.listenerCount('error')).toBe(0);
    },
  );

  it('coalesces concurrent clicks and keeps acknowledged launch from being replayed', async () => {
    const service = downloadedService();
    const first = service.installUpdate();
    const second = service.installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(child.listenerCount('spawn')).toBe(1);
    expect(child.listenerCount('error')).toBe(1);
    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(400);
    const result = await first;
    await expect(second).resolves.toEqual(result);
    await expect(service.installUpdate()).resolves.toEqual(result);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it.each([73, 1, 0, null])(
    'keeps Otto open without fallback when the started installer exits early: %s',
    async (code) => {
      const service = downloadedService();
      const pending = service.installUpdate();
      await vi.advanceTimersByTimeAsync(0);
      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(200);
      child.emit('exit', code, code === null ? 'SIGTERM' : null);
      child.emit('close', code);
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining('保持运行'),
      });
      if (code !== null) expect(result.message).toContain(`退出码 ${code}`);
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(service.installUpdate()).resolves.toEqual(result);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.openPath).not.toHaveBeenCalled();
      expect(mocks.quit).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.eventNames()).toEqual([]);
    },
  );

  it('does not replay a started installer that reports an error during the startup buffer', async () => {
    const pending = downloadedService().installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    child.emit('spawn');
    expect(() =>
      child.emit('error', new Error('post-spawn failure')),
    ).not.toThrow();
    child.emit('close', 1);
    await expect(pending).resolves.toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it('does not launch a file that failed the install-time integrity recheck', async () => {
    mocks.verify.mockResolvedValue({
      ok: false,
      message: '安装包文件已被改动',
    });
    await expect(downloadedService().installUpdate()).resolves.toEqual({
      ok: false,
      message: '安装包文件已被改动',
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it.each([new Error('verification read failed'), 'verification read failed'])(
    'returns useful preparation errors and permits an explicitly reverified retry: %j',
    async (error) => {
      const service = downloadedService();
      mocks.verify.mockRejectedValueOnce(error);
      await expect(service.installUpdate()).resolves.toEqual({
        ok: false,
        message: '准备安装更新失败：verification read failed',
      });
      expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(
        installerPath,
        'a'.repeat(64),
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.openPath).not.toHaveBeenCalled();
      expect(mocks.quit).not.toHaveBeenCalled();

      const retried = service.installUpdate();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.verify).toHaveBeenCalledTimes(2);
      expect(mocks.verify).toHaveBeenNthCalledWith(
        2,
        installerPath,
        'a'.repeat(64),
      );
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.quit).not.toHaveBeenCalled();
      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(400);
      await expect(retried).resolves.toMatchObject({ ok: true });
      expect(mocks.openPath).not.toHaveBeenCalled();
    },
  );
});
