/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type DesktopDistributionId = 'otto' | 'otto-green';

export interface DesktopDistributionInfo {
  id: DesktopDistributionId;
  productName: string;
  wordmark: string;
  appUserModelId: string;
  protocolScheme: string;
  userDataDirectoryName: string;
  userRootDirectoryName: string;
  localServerPort: number;
}

const DISTRIBUTIONS: Record<DesktopDistributionId, DesktopDistributionInfo> = {
  otto: {
    id: 'otto',
    productName: 'Otto',
    wordmark: 'otto',
    appUserModelId: 'ai.otto.desktop',
    protocolScheme: 'otto',
    userDataDirectoryName: 'Otto',
    userRootDirectoryName: '.otto-user',
    localServerPort: 7637,
  },
  'otto-green': {
    id: 'otto-green',
    productName: 'Otto Green',
    wordmark: 'otto.green',
    appUserModelId: 'ai.otto.green.desktop',
    protocolScheme: 'otto-green',
    userDataDirectoryName: 'Otto Green',
    userRootDirectoryName: '.otto-green-user',
    localServerPort: 7638,
  },
};

export function isDesktopDistributionId(
  value: unknown,
): value is DesktopDistributionId {
  return value === 'otto' || value === 'otto-green';
}

export function resolveDesktopDistribution(
  input: {
    packageDistributionId?: unknown;
    developmentOverride?: unknown;
  } = {},
): DesktopDistributionInfo {
  const id = isDesktopDistributionId(input.packageDistributionId)
    ? input.packageDistributionId
    : isDesktopDistributionId(input.developmentOverride)
      ? input.developmentOverride
      : 'otto';
  return DISTRIBUTIONS[id];
}
