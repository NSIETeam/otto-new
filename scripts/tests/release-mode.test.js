/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { validateReleaseMode } from '../validate-release-mode.mjs';

const stable = {
  repository: 'NSIETeam/otto-new',
  eventName: 'workflow_dispatch',
  releaseChannel: 'stable',
  draft: false,
  prerelease: false,
  unsignedMacTransition: false,
  unsignedDesktopStable: false,
};

describe('desktop release mode authorization', () => {
  it('allows explicit legacy administrative waiver while preserving the desktop mode', () => {
    expect(
      validateReleaseMode({ ...stable, allowUnverifiedLegacyMutability: true }),
    ).toEqual({ unsignedDesktop: false });
  });

  it.each([
    { eventName: 'push' },
    {
      releaseChannel: 'transition',
      unsignedMacTransition: true,
      draft: true,
      prerelease: true,
    },
    { draft: true, prerelease: true },
  ])(
    'rejects legacy administrative waiver outside manual stable mode %j',
    (change) => {
      expect(() =>
        validateReleaseMode({
          ...stable,
          allowUnverifiedLegacyMutability: true,
          ...change,
        }),
      ).toThrow();
    },
  );
  it('keeps signed stable publication as the default, including tag pushes', () => {
    expect(validateReleaseMode(stable)).toEqual({ unsignedDesktop: false });
    expect(validateReleaseMode({ ...stable, eventName: 'push' })).toEqual({
      unsignedDesktop: false,
    });
  });

  it.each([false, true])(
    'allows explicitly unsigned stable with draft=%s',
    (draft) => {
      expect(
        validateReleaseMode({ ...stable, draft, unsignedDesktopStable: true }),
      ).toEqual({ unsignedDesktop: true });
    },
  );

  it('preserves the isolated unsigned transition test mode', () => {
    expect(
      validateReleaseMode({
        ...stable,
        unsignedMacTransition: true,
        releaseChannel: 'transition',
        draft: true,
        prerelease: true,
      }),
    ).toEqual({ unsignedDesktop: true });
  });

  it.each([
    { eventName: 'push' },
    { releaseChannel: 'transition' },
    { releaseChannel: 'lstc' },
    { prerelease: true },
    { unsignedMacTransition: true },
    { repository: 'Felix201209/otto-releases' },
  ])('rejects unsigned stable with incompatible input %j', (change) => {
    expect(() =>
      validateReleaseMode({
        ...stable,
        unsignedDesktopStable: true,
        ...change,
      }),
    ).toThrow();
  });

  it.each([
    { unsignedMacTransition: true },
    { releaseChannel: 'transition' },
    { prerelease: true },
    { releaseChannel: 'unrecognized' },
    { eventName: 'pull_request' },
  ])('rejects unsafe or unknown mode %j', (change) => {
    expect(() => validateReleaseMode({ ...stable, ...change })).toThrow();
  });
});
