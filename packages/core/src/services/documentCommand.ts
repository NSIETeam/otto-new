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
    cachedWindowsConsoleEncoding = codePage === '65001'
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
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFileImpl ?? defaultExecFileImpl;
  const usesWindowsNpmShim = platform === 'win32'
    && /^(?:marp|marp-cli)(?:\.cmd)?$/i.test(path.basename(file));
  const executable = usesWindowsNpmShim
    ? (options.comspec || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
    : file;
  const argv = usesWindowsNpmShim
    ? ['/d', '/s', '/c', file, ...args]
    : args;
  return new Promise<void>((resolve, reject) => {
    execFileImpl(
      executable,
      argv,
      {
        encoding: 'buffer',
        windowsHide: true,
        timeout: options.timeout ?? 30_000,
        maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024,
        signal: options.signal,
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = decodeCommandOutput(
          (stderr && stderr.length > 0) ? stderr : stdout,
          platform,
          options.windowsEncoding,
        ).trim();
        const wrapped = new Error(detail || error.message);
        Object.assign(wrapped, { code: error.code, cause: error });
        reject(wrapped);
      },
    );
  });
}

export type DocumentCommandRunner = typeof runDocumentCommand;
