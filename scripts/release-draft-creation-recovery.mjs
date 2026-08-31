#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const execFile = promisify(execFileCallback);

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

function stableJson(value) {
  return JSON.stringify(value);
}

function assertExactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  ) {
    throw new Error(`${label} schema is invalid`);
  }
}

function normalizeLatestPointer(pointer, label) {
  if (pointer === null) return null;
  assertExactKeys(pointer, ['id', 'tagName'], `${label} latest pointer`);
  if (
    !Number.isSafeInteger(pointer.id) ||
    pointer.id <= 0 ||
    typeof pointer.tagName !== 'string' ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(pointer.tagName)
  ) {
    throw new Error(`${label} latest pointer is invalid`);
  }
  return { id: pointer.id, tagName: pointer.tagName };
}

export function selectExactReleaseByTagPages(pages, tag) {
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag ?? '') ||
    !Array.isArray(pages) ||
    pages.some((page) => !Array.isArray(page))
  ) {
    throw new Error('GitHub release list response is invalid');
  }
  const releases = pages.flat();
  if (
    releases.some(
      (release) =>
        !release || typeof release !== 'object' || Array.isArray(release),
    )
  ) {
    throw new Error('GitHub release list response is invalid');
  }
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length > 1) {
    throw new Error('exact GitHub release tag is ambiguous');
  }
  return matches[0] ?? null;
}

async function collectRegularFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`release artifact contains a symbolic link: ${target}`);
    }
    if (entry.isDirectory()) {
      await collectRegularFiles(target, files);
    } else if (entry.isFile()) {
      files.push(target);
    } else {
      throw new Error(`release artifact contains an unsafe entry: ${target}`);
    }
  }
  return files;
}

function expectedAssetNames({ version, packageIdentity, assetProfile }) {
  const desktop = [
    `Otto-${version}-arm64.dmg`,
    `Otto-${version}-arm64.dmg.blockmap`,
    `Otto-${version}-x64.dmg`,
    `Otto-${version}-x64.dmg.blockmap`,
    `Otto-Setup-${version}-win-x64.exe`,
    `Otto-Setup-${version}-win-x64.exe.blockmap`,
    'latest.json',
    'SHA256SUMS',
  ];
  if (assetProfile === 'unsigned-transition') return desktop;
  return [
    ...desktop,
    'SHA256SUMS.sig',
    'UPDATE-MIRROR-SHA256SUMS',
    'UPDATE-MIRROR-SHA256SUMS.sig',
    `otto-enterprise-oneclick-v${version}-${packageIdentity}.tar.gz`,
    `otto-enterprise-oneclick-v${version}-${packageIdentity}.tar.gz.sha256`,
    `otto-enterprise-oneclick-v${version}-${packageIdentity}.tar.gz.sig`,
  ];
}

export async function buildExpectedDraftIdentity({
  artifactDirectory,
  version,
  packageIdentity,
  prerelease,
  assetProfile,
}) {
  const packageIdentityIsValid =
    assetProfile === 'production'
      ? /^[0-9a-f]{12}-[0-9a-f]{12}$/.test(packageIdentity ?? '')
      : assetProfile === 'unsigned-transition' && packageIdentity === null;
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ||
    !packageIdentityIsValid ||
    typeof prerelease !== 'boolean' ||
    !['production', 'unsigned-transition'].includes(assetProfile)
  ) {
    throw new Error('draft creation identity arguments are invalid');
  }
  const root = path.resolve(artifactDirectory);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('release artifact directory is unsafe');
  }
  const files = await collectRegularFiles(root);
  const assets = [];
  for (const name of expectedAssetNames({
    version,
    packageIdentity,
    assetProfile,
  })) {
    const matches = files.filter((file) => path.basename(file) === name);
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one immutable artifact named ${name}, found ${matches.length}`,
      );
    }
    const assetMetadata = await lstat(matches[0]);
    if (
      !assetMetadata.isFile() ||
      assetMetadata.isSymbolicLink() ||
      assetMetadata.size <= 0
    ) {
      throw new Error(`release artifact is empty or unsafe: ${name}`);
    }
    assets.push({
      name,
      size: assetMetadata.size,
      digest: `sha256:${await sha256File(matches[0])}`,
    });
  }
  const notes = files.filter(
    (file) => path.basename(file) === 'release-notes.md',
  );
  if (notes.length !== 1) {
    throw new Error(
      `expected exactly one release-notes.md, found ${notes.length}`,
    );
  }
  const notesMetadata = await lstat(notes[0]);
  if (!notesMetadata.isFile() || notesMetadata.isSymbolicLink()) {
    throw new Error('release notes are unsafe');
  }
  return {
    releaseName: `Otto v${version}`,
    bodySha256: sha256Text(await readFile(notes[0], 'utf8')),
    prerelease,
    assetProfile,
    assets: assets.sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    ),
  };
}

function validateAssetVector(
  assets,
  expectedProfile,
  version,
  packageIdentity,
) {
  if (!Array.isArray(assets))
    throw new Error('creation asset vector is invalid');
  const expectedNames = expectedAssetNames({
    version,
    packageIdentity,
    assetProfile: expectedProfile,
  }).sort((left, right) => left.localeCompare(right, 'en'));
  const normalized = assets.map((asset) => {
    assertExactKeys(asset, ['digest', 'name', 'size'], 'creation asset');
    if (
      typeof asset.name !== 'string' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '')
    ) {
      throw new Error('creation asset is incomplete');
    }
    return { name: asset.name, size: asset.size, digest: asset.digest };
  });
  const names = normalized.map(({ name }) => name);
  if (
    new Set(names).size !== names.length ||
    stableJson(names) !== stableJson(expectedNames)
  ) {
    throw new Error('creation asset names are not exact');
  }
  return normalized;
}

function validateCreationIntent(intent, expected) {
  assertExactKeys(
    intent,
    [
      'canonicalCommit',
      'canonicalRepository',
      'createLegacy',
      'expected',
      'format',
      'legacyMainCommit',
      'legacyRepository',
      'prePublicLatest',
      'preexisting',
      'run',
      'tag',
    ],
    'release creation intent',
  );
  assertExactKeys(intent.run, ['attempt', 'id'], 'release creation run');
  assertExactKeys(
    intent.preexisting,
    ['canonical', 'legacy'],
    'release creation preexistence',
  );
  for (const key of ['canonical', 'legacy']) {
    assertExactKeys(
      intent.preexisting[key],
      ['release', 'tag'],
      `${key} release creation preexistence`,
    );
  }
  assertExactKeys(
    intent.expected,
    [
      'assetProfile',
      'assets',
      'bodySha256',
      'packageIdentity',
      'prerelease',
      'releaseName',
      'tagCommits',
      'targets',
      'version',
    ],
    'expected draft creation',
  );
  assertExactKeys(
    intent.expected.targets,
    ['canonical', 'legacy'],
    'draft targets',
  );
  assertExactKeys(
    intent.expected.tagCommits,
    ['canonical', 'legacy'],
    'draft tag commits',
  );
  assertExactKeys(
    intent.prePublicLatest,
    [
      'canonicalCommit',
      'canonicalRepository',
      'format',
      'latest',
      'legacyRepository',
      'tag',
    ],
    'pre-public latest snapshot',
  );
  assertExactKeys(
    intent.prePublicLatest.latest,
    ['canonical', 'legacy'],
    'pre-public latest pointers',
  );
  const version = intent.tag?.slice(1);
  const production = intent.expected?.assetProfile === 'production';
  const packageIdentityIsValid = production
    ? /^[0-9a-f]{12}-[0-9a-f]{12}$/.test(intent.expected.packageIdentity ?? '')
    : intent.expected?.assetProfile === 'unsigned-transition' &&
      intent.expected.packageIdentity === null;
  const legacyBindingIsValid = production
    ? /^[0-9a-f]{40}$/.test(intent.legacyMainCommit ?? '') &&
      intent.expected.targets.legacy === intent.legacyMainCommit &&
      intent.expected.tagCommits.legacy === intent.legacyMainCommit
    : intent.legacyMainCommit === null &&
      intent.expected.targets.legacy === null &&
      intent.expected.tagCommits.legacy === null;
  const valid =
    intent.format === 'otto-release-creation-intent-v1' &&
    intent.run.id === expected.runId &&
    intent.run.attempt === 1 &&
    intent.tag === expected.tag &&
    intent.canonicalRepository === expected.canonicalRepository &&
    intent.legacyRepository === expected.legacyRepository &&
    intent.canonicalCommit === expected.canonicalCommit &&
    /^[0-9a-f]{40}$/.test(intent.canonicalCommit ?? '') &&
    legacyBindingIsValid &&
    typeof intent.createLegacy === 'boolean' &&
    typeof intent.preexisting.canonical.tag === 'boolean' &&
    intent.preexisting.canonical.release === false &&
    intent.preexisting.legacy.tag === false &&
    intent.preexisting.legacy.release === false &&
    intent.expected.version === version &&
    intent.expected.packageIdentity === expected.packageIdentity &&
    intent.expected.assetProfile === expected.assetProfile &&
    packageIdentityIsValid &&
    /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(intent.tag ?? '') &&
    /^[0-9a-f]{64}$/.test(intent.expected.bodySha256 ?? '') &&
    intent.expected.releaseName === `Otto ${intent.tag}` &&
    typeof intent.expected.prerelease === 'boolean' &&
    ['production', 'unsigned-transition'].includes(
      intent.expected.assetProfile,
    ) &&
    intent.createLegacy === (intent.expected.assetProfile === 'production') &&
    intent.expected.targets.canonical === intent.canonicalCommit &&
    intent.expected.tagCommits.canonical === intent.canonicalCommit &&
    intent.prePublicLatest.format === 'otto-pre-public-latest-v1' &&
    intent.prePublicLatest.tag === intent.tag &&
    intent.prePublicLatest.canonicalRepository === intent.canonicalRepository &&
    intent.prePublicLatest.legacyRepository === intent.legacyRepository &&
    intent.prePublicLatest.canonicalCommit === intent.canonicalCommit;
  if (!valid) throw new Error('release creation intent binding is invalid');
  const assets = validateAssetVector(
    intent.expected.assets,
    intent.expected.assetProfile,
    version,
    intent.expected.packageIdentity,
  );
  return {
    ...intent,
    expected: { ...intent.expected, assets },
    prePublicLatest: {
      ...intent.prePublicLatest,
      latest: {
        canonical: normalizeLatestPointer(
          intent.prePublicLatest.latest.canonical,
          'canonical pre-public',
        ),
        legacy: normalizeLatestPointer(
          intent.prePublicLatest.latest.legacy,
          'legacy pre-public',
        ),
      },
    },
  };
}

export function parseReleaseCreationIntent(text, expected) {
  if (
    typeof text !== 'string' ||
    !/^[0-9a-f]{64}$/.test(expected.sha256 ?? '') ||
    sha256Text(text) !== expected.sha256
  ) {
    throw new Error('release creation intent digest is invalid');
  }
  let intent;
  try {
    intent = JSON.parse(text);
  } catch {
    throw new Error('release creation intent is not valid JSON');
  }
  return validateCreationIntent(intent, expected);
}

function assertPointer(actual, expected, label) {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} latest pointer changed`);
  }
}

async function observePreCreation(adapter, endpoints, tag, createLegacy) {
  const legacy = createLegacy
    ? {
        repository: await adapter.getRepositoryIdentity(endpoints.legacy),
        mainCommit: await adapter.getBranchCommit(endpoints.legacy, 'main'),
        tagCommit: await adapter.getTagCommit(endpoints.legacy, tag),
        release: await adapter.getRelease(endpoints.legacy, tag),
        latest: await adapter.getLatest(endpoints.legacy),
      }
    : {
        repository: endpoints.legacy.repository,
        mainCommit: null,
        tagCommit: null,
        release: null,
        latest: null,
      };
  return {
    canonical: {
      repository: await adapter.getRepositoryIdentity(endpoints.canonical),
      tagCommit: await adapter.getTagCommit(endpoints.canonical, tag),
      release: await adapter.getRelease(endpoints.canonical, tag),
      latest: await adapter.getLatest(endpoints.canonical),
    },
    legacy,
  };
}

function assertPreCreationState(observed, intent) {
  if (
    observed.canonical.repository.toLowerCase() !==
      intent.canonicalRepository.toLowerCase() ||
    observed.legacy.repository.toLowerCase() !==
      intent.legacyRepository.toLowerCase() ||
    observed.legacy.mainCommit !== intent.legacyMainCommit ||
    observed.canonical.release !== null ||
    observed.legacy.release !== null ||
    observed.canonical.tagCommit !==
      (intent.preexisting.canonical.tag ? intent.canonicalCommit : null) ||
    observed.legacy.tagCommit !== null
  ) {
    throw new Error('remote release creation preconditions changed');
  }
  assertPointer(
    observed.canonical.latest,
    intent.prePublicLatest.latest.canonical,
    'canonical pre-public',
  );
  assertPointer(
    observed.legacy.latest,
    intent.prePublicLatest.latest.legacy,
    'legacy pre-public',
  );
}

export async function captureReleaseCreationIntent({
  adapter,
  endpoints,
  expected,
  runId,
  canonicalTagPreexisting,
  createLegacy,
}) {
  if (
    !/^\d+$/.test(runId ?? '') ||
    typeof canonicalTagPreexisting !== 'boolean' ||
    typeof createLegacy !== 'boolean' ||
    createLegacy !== (expected.assetProfile === 'production')
  ) {
    throw new Error('release creation capture arguments are invalid');
  }
  const first = await observePreCreation(
    adapter,
    endpoints,
    expected.tag,
    createLegacy,
  );
  const second = await observePreCreation(
    adapter,
    endpoints,
    expected.tag,
    createLegacy,
  );
  if (stableJson(first) !== stableJson(second)) {
    throw new Error('remote release creation state changed during capture');
  }
  const intent = {
    format: 'otto-release-creation-intent-v1',
    run: { id: runId, attempt: 1 },
    tag: expected.tag,
    canonicalRepository: endpoints.canonical.repository,
    legacyRepository: endpoints.legacy.repository,
    canonicalCommit: expected.canonicalCommit,
    legacyMainCommit: first.legacy.mainCommit,
    createLegacy,
    preexisting: {
      canonical: { tag: canonicalTagPreexisting, release: false },
      legacy: { tag: false, release: false },
    },
    expected: {
      version: expected.tag.slice(1),
      packageIdentity: expected.packageIdentity,
      releaseName: expected.releaseName,
      bodySha256: expected.bodySha256,
      prerelease: expected.prerelease,
      assetProfile: expected.assetProfile,
      targets: {
        canonical: expected.canonicalCommit,
        legacy: createLegacy ? first.legacy.mainCommit : null,
      },
      tagCommits: {
        canonical: expected.canonicalCommit,
        legacy: createLegacy ? first.legacy.mainCommit : null,
      },
      assets: expected.assets,
    },
    prePublicLatest: {
      format: 'otto-pre-public-latest-v1',
      tag: expected.tag,
      canonicalRepository: endpoints.canonical.repository,
      legacyRepository: endpoints.legacy.repository,
      canonicalCommit: expected.canonicalCommit,
      latest: {
        canonical: first.canonical.latest,
        legacy: first.legacy.latest,
      },
    },
  };
  assertPreCreationState(first, intent);
  return validateCreationIntent(intent, {
    runId,
    tag: expected.tag,
    canonicalRepository: endpoints.canonical.repository,
    legacyRepository: endpoints.legacy.repository,
    canonicalCommit: expected.canonicalCommit,
    packageIdentity: expected.packageIdentity,
    assetProfile: expected.assetProfile,
  });
}

export async function verifyReleaseCreationIntent({
  adapter,
  endpoints,
  intent,
}) {
  for (let observation = 0; observation < 2; observation += 1) {
    assertPreCreationState(
      await observePreCreation(
        adapter,
        endpoints,
        intent.tag,
        intent.createLegacy,
      ),
      intent,
    );
  }
  return intent;
}

function normalizeObservedAsset(asset) {
  return {
    id: asset?.id,
    name: asset?.name,
    size: asset?.size,
    digest: asset?.digest,
    state: asset?.state,
  };
}

function normalizeObservedRelease(release) {
  if (release === null) return null;
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('partial release state is invalid');
  }
  const assets = Array.isArray(release.assets)
    ? release.assets
        .map(normalizeObservedAsset)
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    : null;
  if (!assets) throw new Error('partial release assets are invalid');
  return {
    id: release.id,
    tagName: release.tag_name,
    targetCommitish: release.target_commitish,
    name: release.name,
    bodySha256: sha256Text(release.body ?? ''),
    draft: release.draft,
    prerelease: release.prerelease,
    assets,
  };
}

async function observeCleanupState(adapter, endpoints, intent) {
  const observe = async (endpoint) => ({
    tagCommit: await adapter.getTagCommit(endpoint, intent.tag),
    release: normalizeObservedRelease(
      await adapter.getRelease(endpoint, intent.tag),
    ),
    latest: await adapter.getLatest(endpoint),
  });
  return {
    canonical: await observe(endpoints.canonical),
    legacy: intent.createLegacy
      ? await observe(endpoints.legacy)
      : { tagCommit: null, release: null, latest: null },
  };
}

async function observeStableCleanupState(adapter, endpoints, intent) {
  let previous;
  let consecutive = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await observeCleanupState(adapter, endpoints, intent);
    if (
      previous !== undefined &&
      stableJson(current) === stableJson(previous)
    ) {
      consecutive += 1;
      if (consecutive >= 2) return current;
    } else {
      consecutive = 0;
    }
    previous = current;
    await adapter.waitForConsistency?.();
  }
  throw new Error('partial release creation did not reach a stable state');
}

function assertExpectedAssetSubset(actual, expected, label) {
  const expectedByName = new Map(expected.map((asset) => [asset.name, asset]));
  const seen = new Set();
  for (const asset of actual) {
    const locked = expectedByName.get(asset.name);
    const uploadedMatches =
      asset.state === 'uploaded' &&
      asset.size === locked?.size &&
      asset.digest === locked?.digest;
    const incompleteUploadMatches =
      asset.state === 'starter' &&
      asset.size === 0 &&
      (asset.digest === null ||
        asset.digest === undefined ||
        asset.digest === '');
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      seen.has(asset.name) ||
      !locked ||
      (!uploadedMatches && !incompleteUploadMatches)
    ) {
      throw new Error(`${label} partial assets are not an expected subset`);
    }
    seen.add(asset.name);
  }
}

function assertCleanupState(states, intent, { final = false } = {}) {
  for (const key of ['canonical', 'legacy']) {
    const state = states[key];
    const createsEndpoint = key === 'canonical' || intent.createLegacy;
    const tagPreexisting = intent.preexisting[key].tag;
    const expectedTagCommit = intent.expected.tagCommits[key];
    assertPointer(
      state.latest,
      intent.prePublicLatest.latest[key],
      `${key} cleanup`,
    );
    if (!createsEndpoint) {
      if (state.release !== null || state.tagCommit !== null) {
        throw new Error(`${key} was not part of this creation intent`);
      }
      continue;
    }
    if (tagPreexisting) {
      if (state.tagCommit !== expectedTagCommit) {
        throw new Error(`${key} preexisting tag commit drifted`);
      }
    } else if (
      state.tagCommit !== null &&
      state.tagCommit !== expectedTagCommit
    ) {
      throw new Error(`${key} run-created tag commit drifted`);
    }
    if (final) {
      if (
        state.release !== null ||
        (!tagPreexisting && state.tagCommit !== null)
      ) {
        throw new Error(`${key} partial release creation was not removed`);
      }
      continue;
    }
    if (state.release === null) continue;
    const release = state.release;
    if (
      !Number.isSafeInteger(release.id) ||
      release.id <= 0 ||
      release.tagName !== intent.tag ||
      release.targetCommitish !== intent.expected.targets[key] ||
      release.name !== intent.expected.releaseName ||
      release.bodySha256 !== intent.expected.bodySha256 ||
      release.draft !== true ||
      release.prerelease !== intent.expected.prerelease
    ) {
      throw new Error(`${key} partial release identity is ambiguous`);
    }
    assertExpectedAssetSubset(release.assets, intent.expected.assets, key);
  }
}

export async function cleanupPartialDraftCreation({
  adapter,
  endpoints,
  intent,
}) {
  const locked = await observeStableCleanupState(adapter, endpoints, intent);
  assertCleanupState(locked, intent);
  await adapter.waitForConsistency?.();
  const rechecked = await observeCleanupState(adapter, endpoints, intent);
  if (stableJson(rechecked) !== stableJson(locked)) {
    throw new Error('partial release creation changed before cleanup');
  }
  assertCleanupState(rechecked, intent);

  for (const key of ['canonical', 'legacy']) {
    const starterAssets = locked[key].release?.assets.filter(
      ({ state }) => state === 'starter',
    );
    for (const asset of starterAssets ?? []) {
      try {
        await adapter.deleteAsset(endpoints[key], asset.id);
      } catch (error) {
        const release = normalizeObservedRelease(
          await adapter.getRelease(endpoints[key], intent.tag),
        );
        if (release?.assets.some(({ id }) => id === asset.id)) throw error;
      }
    }
  }
  const startersRemoved = await observeStableCleanupState(
    adapter,
    endpoints,
    intent,
  );
  const expectedAfterStarterRemoval = structuredClone(locked);
  for (const key of ['canonical', 'legacy']) {
    if (expectedAfterStarterRemoval[key].release) {
      expectedAfterStarterRemoval[key].release.assets =
        expectedAfterStarterRemoval[key].release.assets.filter(
          ({ state }) => state !== 'starter',
        );
    }
  }
  if (stableJson(startersRemoved) !== stableJson(expectedAfterStarterRemoval)) {
    throw new Error(
      'partial release state drifted while removing starter assets',
    );
  }
  assertCleanupState(startersRemoved, intent);
  for (const key of ['canonical', 'legacy']) {
    if (
      startersRemoved[key].release?.assets.some(
        ({ state }) => state === 'starter',
      )
    ) {
      throw new Error(`${key} starter assets were not removed exactly`);
    }
  }

  for (const key of ['canonical', 'legacy']) {
    if (startersRemoved[key].release === null) continue;
    try {
      await adapter.deleteRelease(
        endpoints[key],
        startersRemoved[key].release.id,
      );
    } catch (error) {
      if ((await adapter.getRelease(endpoints[key], intent.tag)) !== null) {
        throw error;
      }
    }
  }
  const releasesRemoved = await observeStableCleanupState(
    adapter,
    endpoints,
    intent,
  );
  assertCleanupState(releasesRemoved, intent);
  for (const key of ['canonical', 'legacy']) {
    const createsEndpoint = key === 'canonical' || intent.createLegacy;
    if (
      createsEndpoint &&
      !intent.preexisting[key].tag &&
      releasesRemoved[key].tagCommit !== null
    ) {
      try {
        await adapter.deleteTag(endpoints[key], intent.tag);
      } catch (error) {
        if ((await adapter.getTagCommit(endpoints[key], intent.tag)) !== null) {
          throw error;
        }
      }
    }
  }
  const final = await observeStableCleanupState(adapter, endpoints, intent);
  assertCleanupState(final, intent, { final: true });
  await adapter.waitForConsistency?.();
  const finalRepeat = await observeCleanupState(adapter, endpoints, intent);
  if (stableJson(finalRepeat) !== stableJson(final)) {
    throw new Error('partial release cleanup result did not remain stable');
  }
  assertCleanupState(finalRepeat, intent, { final: true });
  return finalRepeat;
}

async function runGh(token, args) {
  const { stdout } = await execFile('gh', args, {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GH_TOKEN: token,
      GH_PROMPT_DISABLED: '1',
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  return stdout;
}

async function runGhMaybeNotFound(token, args) {
  try {
    return await runGh(token, args);
  } catch (error) {
    if (/HTTP 404/.test(String(error?.stderr ?? ''))) return null;
    throw error;
  }
}

function latestPointer(release) {
  if (release === null) return null;
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id <= 0 ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(release?.tag_name ?? '')
  ) {
    throw new Error('GitHub latest release identity is invalid');
  }
  return { id: release.id, tagName: release.tag_name };
}

export function createGitHubDraftRecoveryAdapter({ tokens }) {
  const tokenFor = (endpoint) => {
    const token = tokens[endpoint.key];
    if (!token) throw new Error(`missing ${endpoint.key} release token`);
    return token;
  };
  return {
    async waitForConsistency() {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    },
    async getRepositoryIdentity(endpoint) {
      return (
        await runGh(tokenFor(endpoint), [
          'api',
          '--method',
          'GET',
          `repos/${endpoint.repository}`,
          '--jq',
          '.full_name',
        ])
      ).trim();
    },
    async getBranchCommit(endpoint, branch) {
      return (
        await runGh(tokenFor(endpoint), [
          'api',
          '--method',
          'GET',
          `repos/${endpoint.repository}/commits/${encodeURIComponent(branch)}`,
          '--jq',
          '.sha',
        ])
      ).trim();
    },
    async getTagCommit(endpoint, tag) {
      const refs = JSON.parse(
        await runGh(tokenFor(endpoint), [
          'api',
          '--method',
          'GET',
          `repos/${endpoint.repository}/git/matching-refs/tags/${encodeURIComponent(tag)}`,
        ]),
      ).filter(({ ref }) => ref === `refs/tags/${tag}`);
      if (refs.length === 0) return null;
      if (refs.length !== 1) throw new Error('exact GitHub tag is ambiguous');
      return (
        await runGh(tokenFor(endpoint), [
          'api',
          '--method',
          'GET',
          `repos/${endpoint.repository}/commits/${encodeURIComponent(tag)}`,
          '--jq',
          '.sha',
        ])
      ).trim();
    },
    async getRelease(endpoint, tag) {
      const token = tokenFor(endpoint);
      const response = await runGh(token, [
        'api',
        '--method',
        'GET',
        '--paginate',
        '--slurp',
        `repos/${endpoint.repository}/releases?per_page=100`,
      ]);
      const listed = selectExactReleaseByTagPages(JSON.parse(response), tag);
      if (listed === null) return null;
      if (!Number.isSafeInteger(listed.id) || listed.id <= 0) {
        throw new Error('exact GitHub release id is invalid');
      }
      const exactResponse = await runGhMaybeNotFound(token, [
        'api',
        '--method',
        'GET',
        `repos/${endpoint.repository}/releases/${listed.id}`,
      ]);
      if (exactResponse === null) return null;
      const exact = JSON.parse(exactResponse);
      if (exact?.id !== listed.id || exact?.tag_name !== tag) {
        throw new Error('exact GitHub release identity changed');
      }
      return exact;
    },
    async getLatest(endpoint) {
      const response = await runGhMaybeNotFound(tokenFor(endpoint), [
        'api',
        '--method',
        'GET',
        `repos/${endpoint.repository}/releases/latest`,
      ]);
      return response === null ? null : latestPointer(JSON.parse(response));
    },
    async deleteRelease(endpoint, releaseId) {
      await runGh(tokenFor(endpoint), [
        'api',
        '--method',
        'DELETE',
        `repos/${endpoint.repository}/releases/${releaseId}`,
      ]);
    },
    async deleteAsset(endpoint, assetId) {
      await runGh(tokenFor(endpoint), [
        'api',
        '--method',
        'DELETE',
        `repos/${endpoint.repository}/releases/assets/${assetId}`,
      ]);
    },
    async deleteTag(endpoint, tag) {
      await runGh(tokenFor(endpoint), [
        'api',
        '--method',
        'DELETE',
        `repos/${endpoint.repository}/git/refs/tags/${encodeURIComponent(tag)}`,
      ]);
    },
  };
}

function parsePairs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined || options.has(name)) {
      throw new Error(
        'draft recovery arguments must be unique --name value pairs',
      );
    }
    options.set(name, value);
  }
  return options;
}

function parseCommon(options) {
  const assetProfile = options.get('--asset-profile');
  const rawPackageIdentity = options.get('--package-identity');
  const common = {
    tag: options.get('--tag'),
    canonicalRepository: options.get('--canonical-repo'),
    legacyRepository: options.get('--legacy-repo'),
    canonicalCommit: options.get('--canonical-commit'),
    packageIdentity:
      assetProfile === 'unsigned-transition' && rawPackageIdentity === ''
        ? null
        : rawPackageIdentity,
    assetProfile,
    runId: options.get('--run-id'),
  };
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(common.tag ?? '') ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      common.canonicalRepository ?? '',
    ) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(common.legacyRepository ?? '') ||
    !/^[0-9a-f]{40}$/.test(common.canonicalCommit ?? '') ||
    !['production', 'unsigned-transition'].includes(common.assetProfile) ||
    (common.assetProfile === 'production' &&
      !/^[0-9a-f]{12}-[0-9a-f]{12}$/.test(common.packageIdentity ?? '')) ||
    (common.assetProfile === 'unsigned-transition' &&
      common.packageIdentity !== null) ||
    !/^\d+$/.test(common.runId ?? '')
  ) {
    throw new Error('draft recovery binding arguments are invalid');
  }
  return common;
}

async function readLockedIntent(options) {
  const file = path.resolve(options.intentFile);
  const metadata = await lstat(file);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > 256 * 1024
  ) {
    throw new Error('release creation intent file is unsafe');
  }
  return parseReleaseCreationIntent(await readFile(file, 'utf8'), {
    sha256: options.intentSha256,
    runId: options.runId,
    tag: options.tag,
    canonicalRepository: options.canonicalRepository,
    legacyRepository: options.legacyRepository,
    canonicalCommit: options.canonicalCommit,
    packageIdentity: options.packageIdentity,
    assetProfile: options.assetProfile,
  });
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const pairs = parsePairs(argv);
  const common = parseCommon(pairs);
  const endpoints = {
    canonical: {
      key: 'canonical',
      repository: common.canonicalRepository,
    },
    legacy: { key: 'legacy', repository: common.legacyRepository },
  };
  const adapter = createGitHubDraftRecoveryAdapter({
    tokens: {
      canonical: process.env.CANONICAL_TOKEN,
      legacy: process.env.LEGACY_TOKEN,
    },
  });

  if (command === 'capture') {
    const artifactDirectory = pairs.get('--artifact-dir');
    const intentFile = pairs.get('--intent-file');
    const prePublicLatestFile = pairs.get('--pre-public-latest-file');
    const assetProfile = common.assetProfile;
    const prerelease = pairs.get('--expected-prerelease');
    const canonicalTagPreexisting = pairs.get('--canonical-tag-preexisting');
    if (
      !artifactDirectory ||
      !intentFile ||
      !prePublicLatestFile ||
      !['production', 'unsigned-transition'].includes(assetProfile) ||
      !['true', 'false'].includes(prerelease ?? '') ||
      !['true', 'false'].includes(canonicalTagPreexisting ?? '') ||
      pairs.size !== 12
    ) {
      throw new Error('draft recovery capture arguments are invalid');
    }
    if (process.env.GITHUB_RUN_ATTEMPT !== '1') {
      throw new Error(
        'release creation intent may only be captured on attempt 1',
      );
    }
    const identity = await buildExpectedDraftIdentity({
      artifactDirectory,
      version: common.tag.slice(1),
      packageIdentity: common.packageIdentity,
      prerelease: prerelease === 'true',
      assetProfile,
    });
    const intent = await captureReleaseCreationIntent({
      adapter,
      endpoints,
      expected: {
        ...identity,
        tag: common.tag,
        canonicalCommit: common.canonicalCommit,
        packageIdentity: common.packageIdentity,
      },
      runId: common.runId,
      canonicalTagPreexisting: canonicalTagPreexisting === 'true',
      createLegacy: assetProfile === 'production',
    });
    const intentText = `${JSON.stringify(intent, null, 2)}\n`;
    const latestText = `${JSON.stringify(intent.prePublicLatest, null, 2)}\n`;
    await writeFile(path.resolve(intentFile), intentText, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(path.resolve(prePublicLatestFile), latestText, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({
        creationIntentSha256: sha256Text(intentText),
        prePublicLatestSha256: sha256Text(latestText),
      })}\n`,
    );
    return;
  }

  const intentFile = pairs.get('--intent-file');
  const intentSha256 = pairs.get('--intent-sha256');
  if (
    !['verify-before-create', 'cleanup'].includes(command) ||
    !intentFile ||
    !/^[0-9a-f]{64}$/.test(intentSha256 ?? '') ||
    pairs.size !== 9
  ) {
    throw new Error('draft recovery command arguments are invalid');
  }
  const intent = await readLockedIntent({
    ...common,
    intentFile,
    intentSha256,
  });
  if (command === 'verify-before-create') {
    await verifyReleaseCreationIntent({ adapter, endpoints, intent });
    process.stdout.write('{"ok":true,"state":"safe-to-create"}\n');
    return;
  }
  const final = await cleanupPartialDraftCreation({
    adapter,
    endpoints,
    intent,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      state: 'partial-drafts-and-run-created-tags-absent',
      canonicalTagPreserved: intent.preexisting.canonical.tag,
      latest: {
        canonical: final.canonical.latest,
        legacy: final.legacy.latest,
      },
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
