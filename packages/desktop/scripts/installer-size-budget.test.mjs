/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  LAST_PUBLIC_WINDOWS_INSTALLER_BYTES,
  MEBIBYTE,
  resolveMacInstallerBudget,
  resolveWindowsInstallerBudget,
} from './installer-size-budget.mjs';

describe('Windows installer size budget', () => {
  it('allows only eight MiB of growth over the latest public installer', () => {
    expect(resolveWindowsInstallerBudget({})).toEqual({
      baselineBytes: LAST_PUBLIC_WINDOWS_INSTALLER_BYTES,
      growthBytes: 8 * MEBIBYTE,
      absoluteMaxBytes: 140 * MEBIBYTE,
      maxBytes: LAST_PUBLIC_WINDOWS_INSTALLER_BYTES + 8 * MEBIBYTE,
    });
  });

  it('uses the absolute ceiling when an overridden growth allowance is larger', () => {
    expect(
      resolveWindowsInstallerBudget({
        OTTO_DESKTOP_BASELINE_INSTALLER_BYTES: String(130 * MEBIBYTE),
        OTTO_DESKTOP_MAX_INSTALLER_GROWTH_MB: '20',
        OTTO_DESKTOP_MAX_INSTALLER_MB: '140',
      }).maxBytes,
    ).toBe(140 * MEBIBYTE);
  });

  it('fails closed on invalid environment values', () => {
    expect(() =>
      resolveWindowsInstallerBudget({
        OTTO_DESKTOP_MAX_INSTALLER_GROWTH_MB: 'not-a-number',
      }),
    ).toThrow('OTTO_DESKTOP_MAX_INSTALLER_GROWTH_MB');
  });
});

describe('macOS disk image size budget', () => {
  it('bounds both architectures slightly above the Windows growth ceiling', () => {
    expect(resolveMacInstallerBudget({})).toEqual({ maxBytes: 140 * MEBIBYTE });
    expect(
      resolveMacInstallerBudget({ OTTO_DESKTOP_MAX_DMG_MB: '130' }),
    ).toEqual({ maxBytes: 130 * MEBIBYTE });
  });

  it.each(['0', '-1', 'Infinity', 'NaN', '9007199254740991'])(
    'rejects an invalid DMG budget: %s',
    (value) => {
      expect(() =>
        resolveMacInstallerBudget({ OTTO_DESKTOP_MAX_DMG_MB: value }),
      ).toThrow();
    },
  );
});
