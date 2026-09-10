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
  it('keeps the approved Mac allowance bounded without changing Windows growth', () => {
    expect(resolveMacInstallerBudget({})).toEqual({ maxBytes: 160 * MEBIBYTE });
    expect(resolveWindowsInstallerBudget({}).maxBytes).toBe(136_421_279);
    expect(
      resolveMacInstallerBudget({ OTTO_DESKTOP_MAX_DMG_MB: '130' }),
    ).toEqual({ maxBytes: 130 * MEBIBYTE });
  });

  it.each([160_159_017, 165_870_179])(
    'accepts the observed %i-byte Mac image within the revised allowance',
    (bytes) => {
      expect(bytes).toBeLessThanOrEqual(resolveMacInstallerBudget({}).maxBytes);
      expect(resolveMacInstallerBudget({ OTTO_DESKTOP_MAX_DMG_MB: '160' }))
        .toEqual(resolveMacInstallerBudget({}));
    },
  );

  it.each(['0', '-1', 'Infinity', 'NaN', '9007199254740991'])(
    'rejects an invalid DMG budget: %s',
    (value) => {
      expect(() =>
        resolveMacInstallerBudget({ OTTO_DESKTOP_MAX_DMG_MB: value }),
      ).toThrow();
    },
  );
});
