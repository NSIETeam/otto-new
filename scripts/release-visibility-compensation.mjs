#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const execFile = promisify(execFileCallback);

function stableJson(value) {
  return JSON.stringify(value);
}

function bodyDigest(body) {
  return createHash('sha256')
    .update(body ?? '')
    .digest('hex');
}

function normalizeLatestPointer(pointer, label) {
  if (pointer === null) return null;
  if (
    !pointer ||
    typeof pointer !== 'object' ||
    Array.isArray(pointer) ||
    Object.keys(pointer).sort().join(',') !== 'id,tagName' ||
    !Number.isSafeInteger(pointer.id) ||
    pointer.id <= 0 ||
    typeof pointer.tagName !== 'string' ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(pointer.tagName)
  ) {
    throw new Error(`${label} latest pointer is invalid`);
  }
  return { id: pointer.id, tagName: pointer.tagName };
}

function validatePrePublicationLatestSnapshot(snapshot, expected) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    Object.keys(snapshot).sort().join(',') !==
      'canonicalCommit,canonicalRepository,format,latest,legacyRepository,tag' ||
    snapshot.format !== 'otto-pre-public-latest-v1' ||
    !snapshot.latest ||
    typeof snapshot.latest !== 'object' ||
    Array.isArray(snapshot.latest) ||
    Object.keys(snapshot.latest).sort().join(',') !== 'canonical,legacy' ||
    snapshot.tag !== expected.tag ||
    snapshot.canonicalRepository !== expected.canonicalRepository ||
    snapshot.legacyRepository !== expected.legacyRepository ||
    snapshot.canonicalCommit !== expected.canonicalCommit
  ) {
    throw new Error('pre-public latest snapshot binding is invalid');
  }
  return {
    format: snapshot.format,
    tag: snapshot.tag,
    canonicalRepository: snapshot.canonicalRepository,
    legacyRepository: snapshot.legacyRepository,
    canonicalCommit: snapshot.canonicalCommit,
    latest: {
      canonical: normalizeLatestPointer(
        snapshot.latest.canonical,
        'canonical pre-public',
      ),
      legacy: normalizeLatestPointer(
        snapshot.latest.legacy,
        'legacy pre-public',
      ),
    },
  };
}

export function parsePrePublicationLatestSnapshot(text, expected) {
  if (
    typeof text !== 'string' ||
    !/^[0-9a-f]{64}$/.test(expected.sha256 ?? '') ||
    bodyDigest(text) !== expected.sha256
  ) {
    throw new Error('pre-public latest snapshot digest is invalid');
  }
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new Error('pre-public latest snapshot is not valid JSON');
  }
  return validatePrePublicationLatestSnapshot(snapshot, expected);
}

async function fileDigest(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
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
      throw new Error(
        `release artifact contains a non-regular entry: ${target}`,
      );
    }
  }
  return files;
}

export async function buildExpectedPublication({
  artifactDirectory,
  version,
  packageIdentity,
  prerelease,
}) {
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ||
    !/^[0-9a-f]{12}-[0-9a-f]{12}$/.test(packageIdentity) ||
    typeof prerelease !== 'boolean'
  ) {
    throw new Error('expected publication identity is invalid');
  }
  const root = path.resolve(artifactDirectory);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('release artifact directory is unsafe');
  }
  const files = await collectRegularFiles(root);
  const expectedNames = [
    `Otto-${version}-arm64.dmg`,
    `Otto-${version}-arm64.dmg.blockmap`,
    `Otto-${version}-x64.dmg`,
    `Otto-${version}-x64.dmg.blockmap`,
    `Otto-Setup-${version}-win-x64.exe`,
    `Otto-Setup-${version}-win-x64.exe.blockmap`,
    'latest.json',
    'SHA256SUMS',
    'SHA256SUMS.sig',
    'UPDATE-MIRROR-SHA256SUMS',
    'UPDATE-MIRROR-SHA256SUMS.sig',
    `otto-enterprise-oneclick-v${version}-${packageIdentity}.tar.gz`,
    `otto-enterprise-oneclick-v${version}-${packageIdentity}.tar.gz.sha256`,
    `otto-enterprise-oneclick-v${version}-${packageIdentity}.tar.gz.sig`,
  ];
  const assets = [];
  for (const name of expectedNames) {
    const matches = files.filter((file) => path.basename(file) === name);
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one immutable artifact named ${name}, found ${matches.length}`,
      );
    }
    const metadata = await lstat(matches[0]);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
      throw new Error(`release artifact is empty or unsafe: ${name}`);
    }
    assets.push({
      name,
      size: metadata.size,
      digest: `sha256:${await fileDigest(matches[0])}`,
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
    bodySha256: bodyDigest(await readFile(notes[0], 'utf8')),
    prerelease,
    assets: assets.sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    ),
  };
}

function normalizeAssets(assets) {
  if (!Array.isArray(assets))
    throw new Error('release assets are not an array');
  const normalized = assets
    .map((asset) => ({
      id: asset?.id,
      name: asset?.name,
      label: asset?.label ?? '',
      state: asset?.state,
      contentType: asset?.content_type,
      size: asset?.size,
      digest: asset?.digest,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const names = new Set();
  for (const asset of normalized) {
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      typeof asset.name !== 'string' ||
      !asset.name ||
      names.has(asset.name) ||
      typeof asset.label !== 'string' ||
      asset.state !== 'uploaded' ||
      typeof asset.contentType !== 'string' ||
      !asset.contentType ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '')
    ) {
      throw new Error('release asset snapshot is incomplete or unsafe');
    }
    names.add(asset.name);
  }
  if (normalized.length === 0) throw new Error('release has no assets');
  return normalized;
}

export function normalizeReleaseState({
  repository,
  release,
  canonicalTagCommit = null,
  latestRelease,
}) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error(`release snapshot is invalid for ${repository}`);
  }
  const state = {
    repository,
    identity: {
      id: release.id,
      nodeId: release.node_id,
      apiUrl: release.url,
      tagName: release.tag_name,
      targetCommitish: release.target_commitish,
      name: release.name,
      bodySha256: bodyDigest(release.body),
    },
    visibility: {
      draft: release.draft,
      prerelease: release.prerelease,
    },
    assets: normalizeAssets(release.assets),
    canonicalTagCommit,
    latest: latestRelease
      ? { id: latestRelease.id, tagName: latestRelease.tag_name }
      : null,
  };
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(state.identity.id) ||
    state.identity.id <= 0 ||
    typeof state.identity.nodeId !== 'string' ||
    typeof state.identity.apiUrl !== 'string' ||
    typeof state.identity.tagName !== 'string' ||
    typeof state.identity.targetCommitish !== 'string' ||
    typeof state.identity.name !== 'string' ||
    typeof state.visibility.draft !== 'boolean' ||
    typeof state.visibility.prerelease !== 'boolean' ||
    (canonicalTagCommit !== null &&
      !/^[0-9a-f]{40}$/.test(canonicalTagCommit)) ||
    (state.latest !== null &&
      (!Number.isSafeInteger(state.latest.id) ||
        state.latest.id <= 0 ||
        typeof state.latest.tagName !== 'string' ||
        !state.latest.tagName))
  ) {
    throw new Error(
      `release identity snapshot is incomplete for ${repository}`,
    );
  }
  return state;
}

function portableAssets(state) {
  return state.assets.map(({ name, size, digest }) => ({
    name,
    size,
    digest,
  }));
}

function assertInitialSnapshots(snapshots, expected, prePublicationLatest) {
  const canonical = snapshots.canonical;
  const legacy = snapshots.legacy;
  if (
    canonical.identity.tagName !== expected.tag ||
    legacy.identity.tagName !== expected.tag ||
    canonical.identity.targetCommitish !== expected.canonicalTarget ||
    legacy.identity.targetCommitish !== expected.legacyTarget ||
    canonical.canonicalTagCommit !== expected.canonicalTagCommit ||
    canonical.identity.name !== expected.releaseName ||
    legacy.identity.name !== expected.releaseName ||
    canonical.identity.bodySha256 !== expected.bodySha256 ||
    legacy.identity.bodySha256 !== expected.bodySha256 ||
    canonical.visibility.prerelease !== expected.prerelease ||
    legacy.visibility.prerelease !== expected.prerelease
  ) {
    throw new Error('release identity does not match the locked publication');
  }
  if (
    JSON.stringify(portableAssets(canonical)) !==
      JSON.stringify(expected.assets) ||
    JSON.stringify(portableAssets(legacy)) !== JSON.stringify(expected.assets)
  ) {
    throw new Error('release assets do not match the locked publication');
  }
  for (const key of ['canonical', 'legacy']) {
    const state = snapshots[key];
    const targetIsLatest =
      state.latest?.id === state.identity.id &&
      state.latest?.tagName === state.identity.tagName;
    const prePublicationLatestIsRestored =
      stableJson(state.latest) === stableJson(prePublicationLatest.latest[key]);
    const targetMustBeLatest =
      !state.visibility.draft && !state.visibility.prerelease;
    if (
      (targetMustBeLatest &&
        !targetIsLatest &&
        !prePublicationLatestIsRestored) ||
      (!targetMustBeLatest &&
        (targetIsLatest || !prePublicationLatestIsRestored))
    ) {
      throw new Error('release latest pointer is inconsistent with visibility');
    }
  }
}

function assertLatestPointer(actual, expected, label) {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} latest pointer was not restored exactly`);
  }
}

async function assertPrePublicationLatestRestorable(
  adapter,
  endpoints,
  prePublicationLatest,
) {
  for (const key of ['canonical', 'legacy']) {
    const expectedPointer = prePublicationLatest.latest[key];
    if (expectedPointer === null) continue;
    const actual = await adapter.getReleasePointer(
      endpoints[key],
      expectedPointer.id,
    );
    if (
      !actual ||
      actual.id !== expectedPointer.id ||
      actual.tagName !== expectedPointer.tagName ||
      actual.draft !== false ||
      actual.prerelease !== false
    ) {
      throw new Error(
        `pre-public latest release changed for ${endpoints[key].repository}`,
      );
    }
  }
}

async function restoreLatestPointer(adapter, endpoint, expectedPointer) {
  if (expectedPointer !== null) {
    const actualRelease = await adapter.getReleasePointer(
      endpoint,
      expectedPointer.id,
    );
    if (
      !actualRelease ||
      actualRelease.id !== expectedPointer.id ||
      actualRelease.tagName !== expectedPointer.tagName ||
      actualRelease.draft !== false ||
      actualRelease.prerelease !== false
    ) {
      throw new Error(
        `pre-public latest release changed for ${endpoint.repository}`,
      );
    }
    await adapter.setLatest(endpoint, expectedPointer.id);
  }
  const observed = await adapter.getLatest(endpoint);
  assertLatestPointer(
    observed,
    expectedPointer,
    `${endpoint.repository} pre-public`,
  );
}

function assertStateMatchesSnapshot(
  actual,
  snapshot,
  visibility,
  latestExpectation,
) {
  const targetIsLatest =
    actual.latest?.id === snapshot.identity.id &&
    actual.latest?.tagName === snapshot.identity.tagName;
  const latestMatchesSnapshot =
    stableJson(actual.latest) === stableJson(snapshot.latest);
  if (
    stableJson(actual.identity) !== stableJson(snapshot.identity) ||
    JSON.stringify(actual.assets) !== JSON.stringify(snapshot.assets) ||
    actual.canonicalTagCommit !== snapshot.canonicalTagCommit ||
    actual.visibility.draft !== visibility.draft ||
    actual.visibility.prerelease !== visibility.prerelease ||
    (latestExpectation === 'target' && !targetIsLatest) ||
    (latestExpectation === 'not-target' && targetIsLatest) ||
    (latestExpectation === 'snapshot' && !latestMatchesSnapshot)
  ) {
    throw new Error(`release state diverged for ${snapshot.repository}`);
  }
}

async function observeBoth(adapter, endpoints) {
  const canonical = await adapter.getState(endpoints.canonical);
  const legacy = await adapter.getState(endpoints.legacy);
  return { canonical, legacy };
}

export async function verifyPrePublicationLatest({
  adapter,
  endpoints,
  snapshot,
  expected,
}) {
  const locked = validatePrePublicationLatestSnapshot(snapshot, expected);
  for (let observation = 0; observation < 2; observation += 1) {
    const actual = {
      canonical: await adapter.getLatest(endpoints.canonical),
      legacy: await adapter.getLatest(endpoints.legacy),
    };
    assertLatestPointer(
      actual.canonical,
      locked.latest.canonical,
      `${endpoints.canonical.repository} pre-public`,
    );
    assertLatestPointer(
      actual.legacy,
      locked.latest.legacy,
      `${endpoints.legacy.repository} pre-public`,
    );
  }
  return locked;
}

export async function capturePrePublicationLatest({
  adapter,
  endpoints,
  expected,
}) {
  const capture = async () => ({
    canonical: await adapter.getLatest(endpoints.canonical),
    legacy: await adapter.getLatest(endpoints.legacy),
  });
  const first = await capture();
  const second = await capture();
  if (stableJson(first) !== stableJson(second)) {
    throw new Error('latest pointers changed during pre-public capture');
  }
  return validatePrePublicationLatestSnapshot(
    {
      format: 'otto-pre-public-latest-v1',
      tag: expected.tag,
      canonicalRepository: endpoints.canonical.repository,
      legacyRepository: endpoints.legacy.repository,
      canonicalCommit: expected.canonicalCommit,
      latest: first,
    },
    {
      tag: expected.tag,
      canonicalRepository: endpoints.canonical.repository,
      legacyRepository: endpoints.legacy.repository,
      canonicalCommit: expected.canonicalCommit,
    },
  );
}

export class ReleaseVisibilityCompensationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ReleaseVisibilityCompensationError';
    this.restored = options.restored === true;
  }
}

export async function compensateReleaseVisibility({
  adapter,
  endpoints,
  expected,
  prePublicationLatest,
}) {
  const lockedPrePublicationLatest = validatePrePublicationLatestSnapshot(
    prePublicationLatest,
    {
      tag: expected.tag,
      canonicalRepository: endpoints.canonical.repository,
      legacyRepository: endpoints.legacy.repository,
      canonicalCommit: expected.canonicalTagCommit,
    },
  );
  // Both reads complete before the first mutation. These are the only visibility
  // vectors used for rollback; workflow job results are deliberately irrelevant.
  const snapshots = await observeBoth(adapter, endpoints);
  assertInitialSnapshots(snapshots, expected, lockedPrePublicationLatest);
  await assertPrePublicationLatestRestorable(
    adapter,
    endpoints,
    lockedPrePublicationLatest,
  );
  for (const key of ['canonical', 'legacy']) {
    if (
      snapshots[key].visibility.draft ||
      snapshots[key].visibility.prerelease
    ) {
      assertLatestPointer(
        snapshots[key].latest,
        lockedPrePublicationLatest.latest[key],
        `${endpoints[key].repository} initial`,
      );
    }
  }

  const desired = {
    canonical: {
      // A public Release may already have been observed by a client. Never
      // retract it: only remove its latest pointer and keep every asset URL
      // downloadable. A still-draft endpoint remains draft.
      draft: snapshots.canonical.visibility.draft,
      prerelease: snapshots.canonical.visibility.prerelease,
      makeLatest: false,
    },
    legacy: {
      draft: snapshots.legacy.visibility.draft,
      prerelease: snapshots.legacy.visibility.prerelease,
      makeLatest: false,
    },
  };
  const lockedBeforeMutation = await observeBoth(adapter, endpoints);
  assertStateMatchesSnapshot(
    lockedBeforeMutation.canonical,
    snapshots.canonical,
    snapshots.canonical.visibility,
    'snapshot',
  );
  assertStateMatchesSnapshot(
    lockedBeforeMutation.legacy,
    snapshots.legacy,
    snapshots.legacy.visibility,
    'snapshot',
  );
  const attemptErrors = [];
  for (const key of ['canonical', 'legacy']) {
    try {
      const beforeMutation = await adapter.getState(endpoints[key]);
      assertStateMatchesSnapshot(
        beforeMutation,
        snapshots[key],
        snapshots[key].visibility,
        'snapshot',
      );
      await adapter.setVisibility(
        endpoints[key],
        snapshots[key].identity.id,
        desired[key],
      );
      await restoreLatestPointer(
        adapter,
        endpoints[key],
        lockedPrePublicationLatest.latest[key],
      );
      const observed = await adapter.getState(endpoints[key]);
      assertStateMatchesSnapshot(
        observed,
        snapshots[key],
        desired[key],
        'not-target',
      );
      assertLatestPointer(
        observed.latest,
        lockedPrePublicationLatest.latest[key],
        `${endpoints[key].repository} final`,
      );
    } catch (error) {
      attemptErrors.push({ key, error });
    }
  }

  if (attemptErrors.length === 0) {
    try {
      const finalStates = await observeBoth(adapter, endpoints);
      assertStateMatchesSnapshot(
        finalStates.canonical,
        snapshots.canonical,
        desired.canonical,
        'not-target',
      );
      assertLatestPointer(
        finalStates.canonical.latest,
        lockedPrePublicationLatest.latest.canonical,
        `${endpoints.canonical.repository} final`,
      );
      assertStateMatchesSnapshot(
        finalStates.legacy,
        snapshots.legacy,
        desired.legacy,
        'not-target',
      );
      assertLatestPointer(
        finalStates.legacy.latest,
        lockedPrePublicationLatest.latest.legacy,
        `${endpoints.legacy.repository} final`,
      );
      return { snapshots, finalStates };
    } catch (error) {
      attemptErrors.push({ key: 'final', error });
    }
  }

  // A mutation may have committed even when its response or follow-up read was
  // lost. Restore both endpoints unconditionally to their own observed vectors.
  const restoreMutationErrors = [];
  for (const key of ['canonical', 'legacy']) {
    try {
      await adapter.setVisibility(endpoints[key], snapshots[key].identity.id, {
        ...snapshots[key].visibility,
        makeLatest: snapshots[key].latest?.id === snapshots[key].identity.id,
      });
      if (snapshots[key].latest?.id !== snapshots[key].identity.id) {
        await restoreLatestPointer(
          adapter,
          endpoints[key],
          snapshots[key].latest,
        );
      }
    } catch (error) {
      restoreMutationErrors.push({ key, error });
    }
  }

  let restored = false;
  let restoreVerificationError;
  try {
    const restoredStates = await observeBoth(adapter, endpoints);
    assertStateMatchesSnapshot(
      restoredStates.canonical,
      snapshots.canonical,
      snapshots.canonical.visibility,
      'snapshot',
    );
    assertStateMatchesSnapshot(
      restoredStates.legacy,
      snapshots.legacy,
      snapshots.legacy.visibility,
      'snapshot',
    );
    restored = true;
  } catch (error) {
    restoreVerificationError = error;
  }

  const details = [
    ...attemptErrors.map(
      ({ key, error }) => `${key} latest restore: ${error.message}`,
    ),
    ...restoreMutationErrors.map(
      ({ key, error }) => `${key} restore response: ${error.message}`,
    ),
    ...(restoreVerificationError
      ? [`restore verification: ${restoreVerificationError.message}`]
      : []),
  ].join('; ');
  throw new ReleaseVisibilityCompensationError(
    restored
      ? `latest-pointer compensation failed; exact pre-compensation visibility was restored: ${details}`
      : `CRITICAL: latest-pointer compensation failed and exact visibility restoration could not be proved: ${details}`,
    { cause: attemptErrors[0]?.error, restored },
  );
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
    timeout: 30_000,
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

function latestPointerFromGitHubRelease(release) {
  if (
    !release ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    typeof release.tag_name !== 'string' ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(release.tag_name)
  ) {
    throw new Error('GitHub latest release identity is invalid');
  }
  return { id: release.id, tagName: release.tag_name };
}

export function createGitHubAdapter({ tag, tokens }) {
  async function getLatestRelease(endpoint) {
    const token = tokens[endpoint.key];
    const repositoryIdentity = (
      await runGh(token, [
        'api',
        '--method',
        'GET',
        `repos/${endpoint.repository}`,
        '--jq',
        '.full_name',
      ])
    ).trim();
    if (
      repositoryIdentity.toLowerCase() !== endpoint.repository.toLowerCase()
    ) {
      throw new Error(
        `GitHub repository identity changed: ${endpoint.repository}`,
      );
    }
    const response = await runGhMaybeNotFound(token, [
      'api',
      '--method',
      'GET',
      `repos/${endpoint.repository}/releases/latest`,
    ]);
    return response === null ? null : JSON.parse(response);
  }
  return {
    async getState(endpoint) {
      const token = tokens[endpoint.key];
      const release = JSON.parse(
        await runGh(token, [
          'api',
          '--method',
          'GET',
          `repos/${endpoint.repository}/releases/tags/${encodeURIComponent(tag)}`,
        ]),
      );
      const canonicalTagCommit =
        endpoint.key === 'canonical'
          ? (
              await runGh(token, [
                'api',
                '--method',
                'GET',
                `repos/${endpoint.repository}/commits/${encodeURIComponent(tag)}`,
                '--jq',
                '.sha',
              ])
            ).trim()
          : null;
      const latestRelease = await getLatestRelease(endpoint);
      return normalizeReleaseState({
        repository: endpoint.repository,
        release,
        canonicalTagCommit,
        latestRelease,
      });
    },
    async getLatest(endpoint) {
      const release = await getLatestRelease(endpoint);
      return release === null ? null : latestPointerFromGitHubRelease(release);
    },
    async getReleasePointer(endpoint, releaseId) {
      const token = tokens[endpoint.key];
      const response = await runGhMaybeNotFound(token, [
        'api',
        '--method',
        'GET',
        `repos/${endpoint.repository}/releases/${releaseId}`,
      ]);
      if (response === null) return null;
      const release = JSON.parse(response);
      return {
        ...latestPointerFromGitHubRelease(release),
        draft: release.draft,
        prerelease: release.prerelease,
      };
    },
    async setLatest(endpoint, releaseId) {
      const token = tokens[endpoint.key];
      await runGh(token, [
        'api',
        '--method',
        'PATCH',
        `repos/${endpoint.repository}/releases/${releaseId}`,
        '-f',
        'make_latest=true',
      ]);
    },
    async setVisibility(endpoint, releaseId, visibility) {
      const token = tokens[endpoint.key];
      await runGh(token, [
        'api',
        '--method',
        'PATCH',
        `repos/${endpoint.repository}/releases/${releaseId}`,
        '-F',
        `draft=${visibility.draft}`,
        '-F',
        `prerelease=${visibility.prerelease}`,
        '-f',
        `make_latest=${visibility.makeLatest}`,
      ]);
    },
  };
}

function parsePairs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('compensation arguments must be --name value pairs');
    }
    if (options.has(name)) {
      throw new Error(`duplicate compensation argument: ${name}`);
    }
    options.set(name, value);
  }
  return options;
}

function parseCompensationCli(argv) {
  const options = parsePairs(argv);
  const result = {
    tag: options.get('--tag'),
    canonicalRepository: options.get('--canonical-repo'),
    legacyRepository: options.get('--legacy-repo'),
    canonicalCommit: options.get('--canonical-commit'),
    canonicalTarget: options.get('--canonical-target'),
    legacyTarget: options.get('--legacy-target'),
    artifactDirectory: options.get('--artifact-dir'),
    packageIdentity: options.get('--package-identity'),
    prerelease: options.get('--expected-prerelease'),
    prePublicLatestSnapshot: options.get('--pre-public-latest-snapshot'),
    prePublicLatestSha256: options.get('--pre-public-latest-sha256'),
  };
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(result.tag ?? '') ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      result.canonicalRepository ?? '',
    ) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.legacyRepository ?? '') ||
    !/^[0-9a-f]{40}$/.test(result.canonicalCommit ?? '') ||
    result.canonicalTarget !== result.canonicalCommit ||
    result.legacyTarget !== 'main' ||
    !result.artifactDirectory ||
    !/^[0-9a-f]{12}-[0-9a-f]{12}$/.test(result.packageIdentity ?? '') ||
    !['true', 'false'].includes(result.prerelease ?? '') ||
    !result.prePublicLatestSnapshot ||
    !/^[0-9a-f]{64}$/.test(result.prePublicLatestSha256 ?? '') ||
    options.size !== 11
  ) {
    throw new Error('release visibility compensation arguments are invalid');
  }
  return result;
}

function parseVerifyCli(argv) {
  const options = parsePairs(argv);
  const result = {
    tag: options.get('--tag'),
    canonicalRepository: options.get('--canonical-repo'),
    legacyRepository: options.get('--legacy-repo'),
    canonicalCommit: options.get('--canonical-commit'),
    prePublicLatestSnapshot: options.get('--pre-public-latest-snapshot'),
    prePublicLatestSha256: options.get('--pre-public-latest-sha256'),
  };
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(result.tag ?? '') ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      result.canonicalRepository ?? '',
    ) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.legacyRepository ?? '') ||
    !/^[0-9a-f]{40}$/.test(result.canonicalCommit ?? '') ||
    !result.prePublicLatestSnapshot ||
    !/^[0-9a-f]{64}$/.test(result.prePublicLatestSha256 ?? '') ||
    options.size !== 6
  ) {
    throw new Error('pre-public latest verification arguments are invalid');
  }
  return result;
}

function parseCaptureCli(argv) {
  const options = parsePairs(argv);
  const result = {
    tag: options.get('--tag'),
    canonicalRepository: options.get('--canonical-repo'),
    legacyRepository: options.get('--legacy-repo'),
    canonicalCommit: options.get('--canonical-commit'),
    output: options.get('--output'),
  };
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(result.tag ?? '') ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      result.canonicalRepository ?? '',
    ) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.legacyRepository ?? '') ||
    !/^[0-9a-f]{40}$/.test(result.canonicalCommit ?? '') ||
    !result.output ||
    options.size !== 5
  ) {
    throw new Error('pre-public latest capture arguments are invalid');
  }
  return result;
}

async function readLockedPrePublicationLatest(options) {
  const snapshotPath = path.resolve(options.prePublicLatestSnapshot);
  const metadata = await lstat(snapshotPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > 64 * 1024
  ) {
    throw new Error('pre-public latest snapshot file is unsafe');
  }
  return parsePrePublicationLatestSnapshot(
    await readFile(snapshotPath, 'utf8'),
    {
      sha256: options.prePublicLatestSha256,
      tag: options.tag,
      canonicalRepository: options.canonicalRepository,
      legacyRepository: options.legacyRepository,
      canonicalCommit: options.canonicalCommit,
    },
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options =
    command === 'compensate'
      ? parseCompensationCli(argv)
      : command === 'verify-pre-public-latest'
        ? parseVerifyCli(argv)
        : command === 'capture-pre-public-latest'
          ? parseCaptureCli(argv)
          : null;
  if (!options) {
    throw new Error(
      'release visibility command must be capture-pre-public-latest, verify-pre-public-latest, or compensate',
    );
  }
  const tokens = {
    canonical: process.env.CANONICAL_TOKEN,
    legacy: process.env.LEGACY_TOKEN,
  };
  if (!tokens.canonical || !tokens.legacy) {
    throw new Error('both release visibility compensation tokens are required');
  }
  const endpoints = {
    canonical: {
      key: 'canonical',
      repository: options.canonicalRepository,
    },
    legacy: { key: 'legacy', repository: options.legacyRepository },
  };
  const adapter = createGitHubAdapter({ tag: options.tag, tokens });
  if (command === 'capture-pre-public-latest') {
    const snapshot = await capturePrePublicationLatest({
      adapter,
      endpoints,
      expected: {
        tag: options.tag,
        canonicalCommit: options.canonicalCommit,
      },
    });
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFile(path.resolve(options.output), serialized, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`${bodyDigest(serialized)}\n`);
    return;
  }
  const prePublicationLatest = await readLockedPrePublicationLatest(options);
  if (command === 'verify-pre-public-latest') {
    await verifyPrePublicationLatest({
      adapter,
      endpoints,
      snapshot: prePublicationLatest,
      expected: {
        tag: options.tag,
        canonicalRepository: options.canonicalRepository,
        legacyRepository: options.legacyRepository,
        canonicalCommit: options.canonicalCommit,
      },
    });
    process.stdout.write('{"ok":true,"latest":"pre-public-exact"}\n');
    return;
  }
  const expectedPublication = await buildExpectedPublication({
    artifactDirectory: options.artifactDirectory,
    version: options.tag.slice(1),
    packageIdentity: options.packageIdentity,
    prerelease: options.prerelease === 'true',
  });
  const result = await compensateReleaseVisibility({
    adapter,
    endpoints,
    expected: {
      tag: options.tag,
      canonicalTarget: options.canonicalTarget,
      legacyTarget: options.legacyTarget,
      canonicalTagCommit: options.canonicalCommit,
      ...expectedPublication,
    },
    prePublicationLatest,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      canonical: result.finalStates.canonical.visibility,
      legacy: result.finalStates.legacy.visibility,
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
