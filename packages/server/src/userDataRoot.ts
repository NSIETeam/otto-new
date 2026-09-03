/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import os from 'node:os';
import path from 'node:path';

/** Shared local state root; OTTO_USER_DIR is the isolation contract. */
export function resolveServerUserDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment.OTTO_USER_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homeDirectory, '.otto-user');
}
