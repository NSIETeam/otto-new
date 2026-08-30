/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Windows requires Developer Mode or SeCreateSymbolicLinkPrivilege for file
 * symlinks. Keep the security assertion active everywhere the host can create
 * its fixture, and skip only that fixture on an explicitly unsupported host.
 */
export function canCreateFileSymlinks(): boolean {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'otto-workflow-symlink-probe-'),
  );
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  try {
    writeFileSync(target, 'probe');
    symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (
      process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EACCES')
    ) {
      return false;
    }
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
