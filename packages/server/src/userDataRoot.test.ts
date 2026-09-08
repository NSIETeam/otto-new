/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveServerUserDirectory } from './userDataRoot.js';

describe('server user data root', () => {
  it('honors absolute and relative isolation roots without changing process home', () => {
    const home = path.resolve('fixture-home');
    const isolated = path.resolve('fixture-isolated');
    expect(
      resolveServerUserDirectory({ OTTO_USER_DIR: ` ${isolated} ` }, home),
    ).toBe(isolated);
    expect(
      resolveServerUserDirectory({ OTTO_USER_DIR: 'relative-profile' }, home),
    ).toBe(path.resolve('relative-profile'));
    expect(resolveServerUserDirectory({ OTTO_USER_DIR: '  ' }, home)).toBe(
      path.join(home, '.otto-user'),
    );
    expect(resolveServerUserDirectory({}, home)).toBe(
      path.join(home, '.otto-user'),
    );
  });
});
