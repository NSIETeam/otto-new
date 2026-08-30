/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Server } from 'node:http';

export interface EnterpriseGracefulShutdownRuntime {
  server: Pick<Server, 'close' | 'closeAllConnections'>;
  closeDatabase: () => void;
  forceShutdownTimeoutMs: number;
}

export interface EnterpriseGracefulShutdownOptions {
  hardExit?: (code: number) => void;
  onError?: (error: Error) => void;
}

/**
 * Drains the wrapped enterprise server before closing SQLite. A close error
 * can mean that an accepted external write still lacks its durable checkpoint,
 * so it deliberately keeps the outer watchdog alive and leaves SQLite open.
 */
export function shutdownEnterpriseRuntime(
  runtime: EnterpriseGracefulShutdownRuntime,
  options: EnterpriseGracefulShutdownOptions = {},
): Promise<void> {
  const { server, closeDatabase, forceShutdownTimeoutMs } = runtime;
  const hardExit = options.hardExit ?? ((code: number) => process.exit(code));
  const onError = options.onError ?? (() => undefined);
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      server.closeAllConnections?.();
      const error = new Error(
        `enterprise graceful shutdown exceeded ${forceShutdownTimeoutMs}ms`,
      );
      onError(error);
      hardExit(1);
      // The production hardExit never returns. This rejection keeps injected
      // test/process supervisors deterministic if their hardExit does return.
      reject(error);
    }, forceShutdownTimeoutMs);

    const failClosed = (error: unknown) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      onError(normalized);
      // Do not clear the deadline or close SQLite. The in-flight operation may
      // still finish and checkpoint; the watchdog remains the final boundary.
    };

    try {
      server.close((error?: Error) => {
        if (error) {
          failClosed(error);
          return;
        }
        clearTimeout(deadline);
        try {
          closeDatabase();
          resolve();
        } catch (error) {
          failClosed(error);
          reject(error);
        }
      });
    } catch (error) {
      failClosed(error);
    }
  });
}
