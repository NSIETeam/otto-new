/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveDesktopDistribution } from './desktop-distribution.js';

describe('desktop distribution identity', () => {
  it('keeps the normal Otto identity as the compatibility default', () => {
    expect(resolveDesktopDistribution()).toMatchObject({
      id: 'otto',
      productName: 'Otto',
      wordmark: 'otto',
      appUserModelId: 'ai.otto.desktop',
      protocolScheme: 'otto',
      userRootDirectoryName: '.otto-user',
      localServerPort: 7637,
    });
  });

  it('resolves the isolated Otto Green identity from packaged metadata', () => {
    expect(
      resolveDesktopDistribution({ packageDistributionId: 'otto-green' }),
    ).toMatchObject({
      id: 'otto-green',
      productName: 'Otto Green',
      wordmark: 'otto.green',
      appUserModelId: 'ai.otto.green.desktop',
      protocolScheme: 'otto-green',
      userDataDirectoryName: 'Otto Green',
      userRootDirectoryName: '.otto-green-user',
      localServerPort: 7638,
    });
  });

  it('does not let an invalid identity escape into an unknown channel', () => {
    expect(
      resolveDesktopDistribution({ packageDistributionId: 'customer-name' }),
    ).toMatchObject({ id: 'otto' });
  });
});
