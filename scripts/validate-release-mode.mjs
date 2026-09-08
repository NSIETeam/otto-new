/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateReleaseMode({
  repository,
  eventName,
  releaseChannel,
  draft,
  prerelease,
  unsignedMacTransition,
  unsignedDesktopStable,
  allowUnverifiedLegacyMutability = false,
}) {
  if (repository !== 'NSIETeam/otto-new') {
    throw new Error('Release workflow may only run in NSIETeam/otto-new.');
  }
  if (!['workflow_dispatch', 'push'].includes(eventName)) {
    throw new Error('Unsupported release workflow event.');
  }
  if (!['stable', 'transition'].includes(releaseChannel)) {
    throw new Error('Unsupported release channel.');
  }
  if (
    allowUnverifiedLegacyMutability &&
    (eventName !== 'workflow_dispatch' ||
      releaseChannel !== 'stable' ||
      prerelease ||
      unsignedMacTransition)
  ) {
    throw new Error(
      'Unverified legacy mutability requires explicit workflow_dispatch, stable, non-prerelease mode; canonical verification and exact latest-pointer compensation remain required.',
    );
  }
  if (
    unsignedDesktopStable &&
    (eventName !== 'workflow_dispatch' ||
      releaseChannel !== 'stable' ||
      prerelease ||
      unsignedMacTransition)
  ) {
    throw new Error(
      'Unsigned stable desktop builds require workflow_dispatch, unsigned_desktop_stable=true, release_channel=stable, prerelease=false, and unsigned_mac_transition=false.',
    );
  }
  if (unsignedMacTransition || releaseChannel === 'transition') {
    if (
      eventName !== 'workflow_dispatch' ||
      !unsignedMacTransition ||
      releaseChannel !== 'transition' ||
      !draft ||
      !prerelease
    ) {
      throw new Error(
        'Unsigned transition builds require workflow_dispatch, unsigned_mac_transition=true, release_channel=transition, draft=true, and prerelease=true.',
      );
    }
  }
  if (prerelease && !draft) {
    throw new Error(
      'Prerelease artifacts must remain draft-only and cannot deploy or update existing users.',
    );
  }
  return { unsignedDesktop: unsignedMacTransition || unsignedDesktopStable };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = validateReleaseMode({
    repository: process.env.REPOSITORY,
    eventName: process.env.EVENT_NAME,
    releaseChannel: process.env.RELEASE_CHANNEL,
    draft: process.env.DRAFT_RELEASE === 'true',
    prerelease: process.env.PRERELEASE === 'true',
    unsignedMacTransition: process.env.UNSIGNED_MAC_TRANSITION === 'true',
    unsignedDesktopStable: process.env.UNSIGNED_DESKTOP_STABLE === 'true',
    allowUnverifiedLegacyMutability:
      process.env.ALLOW_UNVERIFIED_LEGACY_MUTABILITY === 'true',
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `unsigned_desktop=${result.unsignedDesktop}\n`,
  );
}
