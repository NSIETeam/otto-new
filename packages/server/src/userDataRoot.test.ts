/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { resolveServerUserDirectory } from './userDataRoot.js';

describe('server user data root', () => {
  it('honors OTTO_USER_DIR without changing the process home', () => {
    expect(resolveServerUserDirectory(
      { OTTO_USER_DIR: '/private/tmp/otto-server-isolated' },
      '/Users/example',
    )).toBe('/private/tmp/otto-server-isolated');
    expect(resolveServerUserDirectory({}, '/Users/example'))
      .toBe('/Users/example/.otto-user');
  });
});
