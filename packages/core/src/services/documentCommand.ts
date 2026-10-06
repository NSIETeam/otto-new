/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFile, execFileSync } from 'child_process';
import path from 'path';
import iconv from 'iconv-lite';

type ExecFileCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: Buffer | string,
  stderr: Buffer | string,
) => void;

export type ExecFileImplementation = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
  callback: ExecFileCallback,
) => unknown;

export interface RunDocumentCommandOptions {
  platform?: NodeJS.Platform;
  comspec?: string;
  windowsEncoding?: string;
  execFileImpl?: ExecFileImplementation;
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

let cachedWindowsConsoleEncoding: string | undefined;

function isUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function detectWindowsConsoleEncoding(): string {
  if (cachedWindowsConsoleEncoding) return cachedWindowsConsoleEncoding;
  try {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    const raw = execFileSync(comspec, ['/d', '/s', '/c', 'chcp'], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 3_000,
    });
    const match = raw.toString('latin1').match(/\b(\d{3,5})\b/);
    const codePage = match?.[1];
    cachedWindowsConsoleEncoding =
      codePage === '65001'
        ? 'utf8'
        : codePage === '936'
          ? 'gb18030'
          : codePage === '950'
            ? 'big5'
            : codePage
              ? `cp${codePage}`
              : 'gb18030';
  } catch {
    // Otto 国内 Windows 用户以 CP936 为主；无法探测时优先避免中文错误乱码。
    cachedWindowsConsoleEncoding = 'gb18030';
  }
  return cachedWindowsConsoleEncoding;
}

function decodeCommandOutput(
  value: Buffer | string,
  platform: NodeJS.Platform,
  windowsEncoding?: string,
): string {
  if (typeof value === 'string') return value;
  if (value.length === 0) return '';
  if (isUtf8(value)) return value.toString('utf8');
  if (platform !== 'win32') return value.toString('utf8');

  const encoding = windowsEncoding || detectWindowsConsoleEncoding();
  return iconv.encodingExists(encoding)
    ? iconv.decode(value, encoding)
    : value.toString('utf8');
}

const defaultExecFileImpl: ExecFileImplementation = (
  file,
  args,
  options,
  callback,
) => execFile(file, [...args], options, callback as never);

/**
 * 以 argv 方式运行文档渲染器，避免把用户路径拼进 shell 命令字符串。
 * stdout/stderr 以 Buffer 接收；Windows 非 UTF-8 控制台输出按当前代码页解码。
 */
export function runDocumentCommand(
  file: string,
  args: string[],
  options: RunDocumentCommandOptions = {},
): Promise<void> {
  if (options.signal?.aborted)
    return Promise.reject(
      options.signal.reason ?? new Error('Document command cancelled'),
    );
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFileImpl ?? defaultExecFileImpl;
  const usesWindowsNpmShim =
    platform === 'win32' &&
    /^(?:marp|marp-cli)(?:\.cmd)?$/i.test(path.basename(file));
  const executable = usesWindowsNpmShim
    ? options.comspec || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
    : file;
  const argv = usesWindowsNpmShim ? ['/d', '/s', '/c', file, ...args] : args;
  return new Promise<void>((resolve, reject) => {
    type Child = { pid?: number; kill?: (signal: NodeJS.Signals) => boolean };
    let child: Child | undefined;
    let settled = false;
    let stopped: Error | undefined;
    let termination: Promise<void> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (force) clearTimeout(force);
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const kill = (hard: boolean): Promise<void> => {
      if (platform === 'win32' && child?.pid) {
        return new Promise((done) =>
          execFile(
            'taskkill',
            ['/PID', String(child!.pid), '/T', '/F'],
            { windowsHide: true, timeout: 1_000 },
            () => done(),
          ),
        );
      }
      const signal: NodeJS.Signals = hard ? 'SIGKILL' : 'SIGTERM';
      try {
        if (child?.pid && platform !== 'win32')
          process.kill(-child.pid, signal);
        else child?.kill?.(signal);
      } catch {
        try {
          child?.kill?.(signal);
        } catch {
          /* Already exited. */
        }
      }
      return Promise.resolve();
    };
    const stop = (error: Error) => {
      if (settled || stopped) return;
      stopped = error;
      clearTimeout(timer);
      // Terminate the exact spawned tree, then permit the caller to clean staging.
      termination = kill(false).then(() => {
        // A launcher exiting on SIGTERM does not prove all of its helpers did.
        // Windows taskkill /T /F already waits for the tree; POSIX needs escalation.
        if (platform === 'win32') return;
        return new Promise<void>((done) => {
          force = setTimeout(() => {
            void kill(true).then(done, done);
          }, 500);
        });
      });
      void termination.then(
        () => finish(stopped),
        () => finish(stopped),
      );
      grace = setTimeout(() => finish(stopped), 1_500);
    };
    const abort = () =>
      stop(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error('Document command cancelled'),
      );
    const timeout = options.timeout ?? 30_000;
    const timer = setTimeout(
      () =>
        stop(
          Object.assign(
            new Error('Document command timeout (' + timeout + ' ms)'),
            { code: 'DOCUMENT_COMMAND_TIMEOUT' },
          ),
        ),
      timeout,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      child = execFileImpl(
        executable,
        argv,
        {
          encoding: 'buffer',
          windowsHide: true,
          // Managed here so timeout/abort cannot kill only a launcher and orphan helpers.
          timeout: 0,
          detached: platform !== 'win32',
          maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024,
          env: options.env,
        },
        (error, stdout, stderr) => {
          if (stopped) {
            void Promise.resolve(termination).then(
              () => finish(stopped),
              () => finish(stopped),
            );
            return;
          }
          if (!error) {
            finish();
            return;
          }
          const detail = decodeCommandOutput(
            stderr && stderr.length > 0 ? stderr : stdout,
            platform,
            options.windowsEncoding,
          ).trim();
          const wrapped = new Error(detail || error.message);
          Object.assign(wrapped, { code: error.code, cause: error });
          finish(wrapped);
        },
      ) as Child | undefined;
      if (options.signal?.aborted) abort();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export type DocumentCommandRunner = typeof runDocumentCommand;
