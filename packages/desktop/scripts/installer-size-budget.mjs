/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const MEBIBYTE = 1024 * 1024;
export const LAST_PUBLIC_WINDOWS_INSTALLER_BYTES = 128_032_671;

function positiveNumber(environment, name, fallback) {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

export function resolveWindowsInstallerBudget(environment = process.env) {
  const baselineBytes = positiveNumber(
    environment,
    'OTTO_DESKTOP_BASELINE_INSTALLER_BYTES',
    LAST_PUBLIC_WINDOWS_INSTALLER_BYTES,
  );
  const growthBytes =
    positiveNumber(environment, 'OTTO_DESKTOP_MAX_INSTALLER_GROWTH_MB', 8) *
    MEBIBYTE;
  const absoluteMaxBytes =
    positiveNumber(environment, 'OTTO_DESKTOP_MAX_INSTALLER_MB', 140) *
    MEBIBYTE;
  const maxBytes = Math.floor(
    Math.min(baselineBytes + growthBytes, absoluteMaxBytes),
  );
  if (!Number.isSafeInteger(maxBytes)) {
    throw new Error('Windows installer size budget exceeds safe integer range');
  }
  return { baselineBytes, growthBytes, absoluteMaxBytes, maxBytes };
}
