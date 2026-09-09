/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCarpoolConfig } from 'otto-server';
export const carpoolTestConfig = readCarpoolConfig({
  OTTO_PARK_CARPOOL_REQUESTS_ENABLED: 'true',
  OTTO_PARK_CARPOOL_INVITATIONS_ENABLED: 'true',
  OTTO_PARK_CARPOOL_GROUPS_ENABLED: 'true',
});
export function carpoolTestNativeBinary(): string {
  const binary = resolve(__dirname, '../../../../otto-native/target/debug', `otto-native${process.platform === 'win32' ? '.exe' : ''}`);
  try {
    if (!statSync(binary).isFile()) throw new Error('not a file');
    accessSync(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(`Native test binary missing or not executable: ${binary}. From repository root run: cargo build --manifest-path otto-native/Cargo.toml --bin otto-native`);
  }
  return binary;
}
