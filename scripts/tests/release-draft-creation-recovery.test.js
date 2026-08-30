import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildExpectedDraftIdentity,
  captureReleaseCreationIntent,
  cleanupPartialDraftCreation,
  parseReleaseCreationIntent,
  verifyReleaseCreationIntent,
} from '../release-draft-creation-recovery.mjs';

const TAG = 'v1.9.14';
const VERSION = '1.9.14';
const SOURCE_COMMIT = 'a'.repeat(40);
const LEGACY_COMMIT = 'b'.repeat(40);
const PACKAGE_IDENTITY = `${'1'.repeat(12)}-${'2'.repeat(12)}`;
const BODY = `Source commit: ${SOURCE_COMMIT}\n`;
const REPOSITORIES = {
  canonical: 'NSIETeam/otto-new',
  legacy: 'Felix201209/otto-releases',
};

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assetNames() {
  return [
    `Otto-${VERSION}-arm64.dmg`,
    `Otto-${VERSION}-arm64.dmg.blockmap`,
    `Otto-${VERSION}-x64.dmg`,
    `Otto-${VERSION}-x64.dmg.blockmap`,
    `Otto-Setup-${VERSION}-win-x64.exe`,
    `Otto-Setup-${VERSION}-win-x64.exe.blockmap`,
    'latest.json',
    'SHA256SUMS',
    'SHA256SUMS.sig',
    'UPDATE-MIRROR-SHA256SUMS',
    'UPDATE-MIRROR-SHA256SUMS.sig',
    `otto-enterprise-oneclick-v${VERSION}-${PACKAGE_IDENTITY}.tar.gz`,
    `otto-enterprise-oneclick-v${VERSION}-${PACKAGE_IDENTITY}.tar.gz.sha256`,
    `otto-enterprise-oneclick-v${VERSION}-${PACKAGE_IDENTITY}.tar.gz.sig`,
  ];
}

function lockedAssets() {
  return assetNames()
    .map((name, index) => ({
      name,
      size: index + 10,
      digest: `sha256:${digest(`asset-${index}`)}`,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function intentFixture({ canonicalTagPreexisting = false } = {}) {
  return {
    format: 'otto-release-creation-intent-v1',
    run: { id: '123456', attempt: 1 },
    tag: TAG,
    canonicalRepository: REPOSITORIES.canonical,
    legacyRepository: REPOSITORIES.legacy,
    canonicalCommit: SOURCE_COMMIT,
    legacyMainCommit: LEGACY_COMMIT,
    createLegacy: true,
    preexisting: {
      canonical: { tag: canonicalTagPreexisting, release: false },
      legacy: { tag: false, release: false },
    },
    expected: {
      version: VERSION,
      packageIdentity: PACKAGE_IDENTITY,
      releaseName: `Otto ${TAG}`,
      bodySha256: digest(BODY),
      prerelease: false,
      assetProfile: 'production',
      targets: { canonical: SOURCE_COMMIT, legacy: 'main' },
      tagCommits: {
        canonical: SOURCE_COMMIT,
        legacy: LEGACY_COMMIT,
      },
      assets: lockedAssets(),
    },
    prePublicLatest: {
      format: 'otto-pre-public-latest-v1',
      tag: TAG,
      canonicalRepository: REPOSITORIES.canonical,
      legacyRepository: REPOSITORIES.legacy,
      canonicalCommit: SOURCE_COMMIT,
      latest: {
        canonical: { id: 91, tagName: 'v1.9.13' },
        legacy: { id: 92, tagName: 'v1.9.13' },
      },
    },
  };
}

function endpoints() {
  return {
    canonical: {
      key: 'canonical',
      repository: REPOSITORIES.canonical,
    },
    legacy: { key: 'legacy', repository: REPOSITORIES.legacy },
  };
}

function rawRelease(intent, key, assets = intent.expected.assets) {
  return {
    id: key === 'canonical' ? 101 : 102,
    tag_name: intent.tag,
    target_commitish: intent.expected.targets[key],
    name: intent.expected.releaseName,
    body: BODY,
    draft: true,
    prerelease: intent.expected.prerelease,
    assets: assets.map((asset, index) => ({
      id: (key === 'canonical' ? 1000 : 2000) + index,
      name: asset.name,
      size: asset.size,
      digest: asset.digest,
      state: 'uploaded',
    })),
  };
}

function cleanupAdapter(states, calls = []) {
  return {
    async getTagCommit(endpoint) {
      return states[endpoint.key].tagCommit;
    },
    async getRelease(endpoint) {
      return structuredClone(states[endpoint.key].release);
    },
    async getLatest(endpoint) {
      return structuredClone(states[endpoint.key].latest);
    },
    async deleteRelease(endpoint, releaseId) {
      calls.push(`release:${endpoint.key}:${releaseId}`);
      states[endpoint.key].release = null;
    },
    async deleteAsset(endpoint, assetId) {
      calls.push(`asset:${endpoint.key}:${assetId}`);
      states[endpoint.key].release.assets = states[
        endpoint.key
      ].release.assets.filter(({ id }) => id !== assetId);
    },
    async deleteTag(endpoint, tag) {
      calls.push(`tag:${endpoint.key}:${tag}`);
      states[endpoint.key].tagCommit = null;
    },
  };
}

describe('release draft creation recovery', () => {
  it('accepts the complete 12-pair unsigned transition capture CLI contract', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve('scripts/release-draft-creation-recovery.mjs'),
        'capture',
        '--tag',
        TAG,
        '--canonical-repo',
        REPOSITORIES.canonical,
        '--legacy-repo',
        REPOSITORIES.legacy,
        '--canonical-commit',
        SOURCE_COMMIT,
        '--package-identity',
        '',
        '--run-id',
        '123456',
        '--artifact-dir',
        'release-download',
        '--asset-profile',
        'unsigned-transition',
        '--expected-prerelease',
        'true',
        '--canonical-tag-preexisting',
        'false',
        '--intent-file',
        'release-state/creation-intent.json',
        '--pre-public-latest-file',
        'release-state/pre-public-latest.json',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_RUN_ATTEMPT: '2' },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'release creation intent may only be captured on attempt 1',
    );
    expect(result.stderr).not.toContain(
      'draft recovery capture arguments are invalid',
    );
  });

  it('captures a SHA-bindable 14-asset intent before mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-draft-intent-'));
    try {
      const nested = path.join(root, 'nested');
      await mkdir(nested);
      await Promise.all(
        assetNames().map((name, index) =>
          writeFile(
            path.join(index % 2 === 0 ? root : nested, name),
            `asset-${index}`,
          ),
        ),
      );
      await writeFile(path.join(root, 'release-notes.md'), BODY);
      const identity = await buildExpectedDraftIdentity({
        artifactDirectory: root,
        version: VERSION,
        packageIdentity: PACKAGE_IDENTITY,
        prerelease: false,
        assetProfile: 'production',
      });
      const adapter = {
        async getRepositoryIdentity(endpoint) {
          return endpoint.repository;
        },
        async getBranchCommit() {
          return LEGACY_COMMIT;
        },
        async getTagCommit(endpoint) {
          return endpoint.key === 'canonical' ? SOURCE_COMMIT : null;
        },
        async getRelease() {
          return null;
        },
        async getLatest(endpoint) {
          return intentFixture().prePublicLatest.latest[endpoint.key];
        },
      };
      const intent = await captureReleaseCreationIntent({
        adapter,
        endpoints: endpoints(),
        expected: {
          ...identity,
          tag: TAG,
          canonicalCommit: SOURCE_COMMIT,
          packageIdentity: PACKAGE_IDENTITY,
          assetProfile: 'production',
        },
        runId: '123456',
        canonicalTagPreexisting: true,
        createLegacy: true,
      });

      expect(intent.expected.assets).toHaveLength(14);
      expect(intent.legacyMainCommit).toBe(LEGACY_COMMIT);
      expect(intent.preexisting).toEqual({
        canonical: { tag: true, release: false },
        legacy: { tag: false, release: false },
      });
      expect(intent.prePublicLatest.latest.canonical.tagName).toBe('v1.9.13');

      const serialized = `${JSON.stringify(intent, null, 2)}\n`;
      expect(
        parseReleaseCreationIntent(serialized, {
          sha256: digest(serialized),
          runId: '123456',
          tag: TAG,
          canonicalRepository: REPOSITORIES.canonical,
          legacyRepository: REPOSITORIES.legacy,
          canonicalCommit: SOURCE_COMMIT,
          packageIdentity: PACKAGE_IDENTITY,
          assetProfile: 'production',
        }),
      ).toEqual(intent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a modified creation journal before any recovery decision', () => {
    const intent = intentFixture();
    const serialized = `${JSON.stringify(intent, null, 2)}\n`;
    expect(() =>
      parseReleaseCreationIntent(serialized.replace('Otto', 'OTTO'), {
        sha256: digest(serialized),
        runId: '123456',
        tag: TAG,
        canonicalRepository: REPOSITORIES.canonical,
        legacyRepository: REPOSITORIES.legacy,
        canonicalCommit: SOURCE_COMMIT,
        packageIdentity: PACKAGE_IDENTITY,
        assetProfile: 'production',
      }),
    ).toThrow('digest');
  });

  it('binds an unsigned transition to null package identity without touching legacy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-transition-intent-'));
    try {
      const transitionNames = assetNames().slice(0, 8);
      await Promise.all(
        transitionNames.map((name, index) =>
          writeFile(path.join(root, name), `transition-${index}`),
        ),
      );
      await writeFile(path.join(root, 'release-notes.md'), BODY);
      const identity = await buildExpectedDraftIdentity({
        artifactDirectory: root,
        version: VERSION,
        packageIdentity: null,
        prerelease: true,
        assetProfile: 'unsigned-transition',
      });
      const legacyAccess = () => {
        throw new Error('transition must not access legacy');
      };
      const adapter = {
        async getRepositoryIdentity(endpoint) {
          if (endpoint.key === 'legacy') legacyAccess();
          return endpoint.repository;
        },
        async getBranchCommit(endpoint) {
          if (endpoint.key === 'legacy') legacyAccess();
          return SOURCE_COMMIT;
        },
        async getTagCommit(endpoint) {
          if (endpoint.key === 'legacy') legacyAccess();
          return SOURCE_COMMIT;
        },
        async getRelease(endpoint) {
          if (endpoint.key === 'legacy') legacyAccess();
          return null;
        },
        async getLatest(endpoint) {
          if (endpoint.key === 'legacy') legacyAccess();
          return { id: 91, tagName: 'v1.9.13' };
        },
      };
      const intent = await captureReleaseCreationIntent({
        adapter,
        endpoints: endpoints(),
        expected: {
          ...identity,
          tag: TAG,
          canonicalCommit: SOURCE_COMMIT,
          packageIdentity: null,
        },
        runId: '123456',
        canonicalTagPreexisting: true,
        createLegacy: false,
      });

      expect(intent.expected.assetProfile).toBe('unsigned-transition');
      expect(intent.expected.packageIdentity).toBeNull();
      expect(intent.legacyMainCommit).toBeNull();
      expect(intent.expected.targets.legacy).toBeNull();
      expect(intent.expected.tagCommits.legacy).toBeNull();
      await verifyReleaseCreationIntent({
        adapter,
        endpoints: endpoints(),
        intent,
      });
      const serialized = `${JSON.stringify(intent, null, 2)}\n`;
      expect(
        parseReleaseCreationIntent(serialized, {
          sha256: digest(serialized),
          runId: '123456',
          tag: TAG,
          canonicalRepository: REPOSITORIES.canonical,
          legacyRepository: REPOSITORIES.legacy,
          canonicalCommit: SOURCE_COMMIT,
          packageIdentity: null,
          assetProfile: 'unsigned-transition',
        }),
      ).toEqual(intent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rechecks the uploaded intent twice immediately before first mutation', async () => {
    const intent = intentFixture({ canonicalTagPreexisting: true });
    let latestReads = 0;
    const adapter = {
      async getRepositoryIdentity(endpoint) {
        return endpoint.repository;
      },
      async getBranchCommit() {
        return LEGACY_COMMIT;
      },
      async getTagCommit(endpoint) {
        return endpoint.key === 'canonical' ? SOURCE_COMMIT : null;
      },
      async getRelease() {
        return null;
      },
      async getLatest(endpoint) {
        latestReads += 1;
        if (latestReads > 2 && endpoint.key === 'canonical') {
          return { id: 90, tagName: 'v1.9.12' };
        }
        return intent.prePublicLatest.latest[endpoint.key];
      },
    };

    await expect(
      verifyReleaseCreationIntent({ adapter, endpoints: endpoints(), intent }),
    ).rejects.toThrow('latest pointer changed');
  });

  it('idempotently resumes when canonical is gone and legacy remains partial', async () => {
    const intent = intentFixture();
    const states = {
      canonical: {
        tagCommit: null,
        release: null,
        latest: intent.prePublicLatest.latest.canonical,
      },
      legacy: {
        tagCommit: LEGACY_COMMIT,
        release: rawRelease(
          intent,
          'legacy',
          intent.expected.assets.slice(0, 4),
        ),
        latest: intent.prePublicLatest.latest.legacy,
      },
    };
    const calls = [];
    const adapter = cleanupAdapter(states, calls);

    await cleanupPartialDraftCreation({
      adapter,
      endpoints: endpoints(),
      intent,
    });
    await cleanupPartialDraftCreation({
      adapter,
      endpoints: endpoints(),
      intent,
    });

    expect(calls).toEqual([`release:legacy:102`, `tag:legacy:${TAG}`]);
    expect(states.canonical.tagCommit).toBeNull();
    expect(states.legacy.tagCommit).toBeNull();
  });

  it('removes partial drafts but preserves a formal push source tag', async () => {
    const intent = intentFixture({ canonicalTagPreexisting: true });
    const states = {
      canonical: {
        tagCommit: SOURCE_COMMIT,
        release: rawRelease(intent, 'canonical'),
        latest: intent.prePublicLatest.latest.canonical,
      },
      legacy: {
        tagCommit: LEGACY_COMMIT,
        release: rawRelease(intent, 'legacy'),
        latest: intent.prePublicLatest.latest.legacy,
      },
    };
    const calls = [];
    await cleanupPartialDraftCreation({
      adapter: cleanupAdapter(states, calls),
      endpoints: endpoints(),
      intent,
    });

    expect(states.canonical.tagCommit).toBe(SOURCE_COMMIT);
    expect(states.legacy.tagCommit).toBeNull();
    expect(calls).not.toContain(`tag:canonical:${TAG}`);
  });

  it('removes exact canonical and legacy starter assets before deleting drafts', async () => {
    const intent = intentFixture();
    const canonicalRelease = rawRelease(
      intent,
      'canonical',
      intent.expected.assets.slice(0, 2),
    );
    const legacyRelease = rawRelease(
      intent,
      'legacy',
      intent.expected.assets.slice(0, 2),
    );
    canonicalRelease.assets.push({
      id: 1099,
      name: intent.expected.assets[2].name,
      size: 0,
      digest: null,
      state: 'starter',
    });
    legacyRelease.assets.push({
      id: 2099,
      name: intent.expected.assets[2].name,
      size: 0,
      digest: '',
      state: 'starter',
    });
    const states = {
      canonical: {
        tagCommit: SOURCE_COMMIT,
        release: canonicalRelease,
        latest: intent.prePublicLatest.latest.canonical,
      },
      legacy: {
        tagCommit: LEGACY_COMMIT,
        release: legacyRelease,
        latest: intent.prePublicLatest.latest.legacy,
      },
    };
    const calls = [];
    await cleanupPartialDraftCreation({
      adapter: cleanupAdapter(states, calls),
      endpoints: endpoints(),
      intent,
    });

    expect(calls.slice(0, 2)).toEqual([
      'asset:canonical:1099',
      'asset:legacy:2099',
    ]);
    expect(calls).toContain('release:canonical:101');
    expect(calls).toContain('release:legacy:102');
  });

  it('continues safely after a starter deletion response is lost', async () => {
    const intent = intentFixture();
    const canonicalRelease = rawRelease(intent, 'canonical', []);
    canonicalRelease.assets.push({
      id: 1099,
      name: intent.expected.assets[0].name,
      size: 0,
      digest: null,
      state: 'starter',
    });
    const states = {
      canonical: {
        tagCommit: SOURCE_COMMIT,
        release: canonicalRelease,
        latest: intent.prePublicLatest.latest.canonical,
      },
      legacy: {
        tagCommit: LEGACY_COMMIT,
        release: rawRelease(intent, 'legacy', []),
        latest: intent.prePublicLatest.latest.legacy,
      },
    };
    const calls = [];
    const adapter = cleanupAdapter(states, calls);
    const deleteAsset = adapter.deleteAsset;
    adapter.deleteAsset = async (...args) => {
      await deleteAsset(...args);
      throw new Error('starter delete response was lost');
    };

    await cleanupPartialDraftCreation({
      adapter,
      endpoints: endpoints(),
      intent,
    });
    expect(calls).toContain('asset:canonical:1099');
    expect(states.canonical.release).toBeNull();
  });

  it('fails closed without deleting anything when a partial release is public', async () => {
    const intent = intentFixture();
    const publicRelease = rawRelease(intent, 'canonical');
    publicRelease.draft = false;
    const states = {
      canonical: {
        tagCommit: SOURCE_COMMIT,
        release: publicRelease,
        latest: intent.prePublicLatest.latest.canonical,
      },
      legacy: {
        tagCommit: LEGACY_COMMIT,
        release: rawRelease(intent, 'legacy'),
        latest: intent.prePublicLatest.latest.legacy,
      },
    };
    const calls = [];

    await expect(
      cleanupPartialDraftCreation({
        adapter: cleanupAdapter(states, calls),
        endpoints: endpoints(),
        intent,
      }),
    ).rejects.toThrow('identity is ambiguous');
    expect(calls).toEqual([]);
  });

  it.each([
    [
      'unexpected asset',
      (intent, states) => {
        states.canonical.release.assets.push({
          name: 'unknown.exe',
          size: 12,
          digest: `sha256:${'f'.repeat(64)}`,
          state: 'uploaded',
        });
      },
      'expected subset',
    ],
    [
      'unknown starter asset',
      (_intent, states) => {
        states.canonical.release.assets.push({
          id: 1099,
          name: 'unknown.exe',
          size: 0,
          digest: null,
          state: 'starter',
        });
      },
      'expected subset',
    ],
    [
      'tag commit drift',
      (_intent, states) => {
        states.legacy.tagCommit = 'c'.repeat(40);
      },
      'tag commit drifted',
    ],
    [
      'latest drift',
      (_intent, states) => {
        states.canonical.latest = { id: 90, tagName: 'v1.9.12' };
      },
      'latest pointer changed',
    ],
  ])('fails closed on %s', async (_label, mutate, message) => {
    const intent = intentFixture();
    const states = {
      canonical: {
        tagCommit: SOURCE_COMMIT,
        release: rawRelease(
          intent,
          'canonical',
          intent.expected.assets.slice(0, 2),
        ),
        latest: intent.prePublicLatest.latest.canonical,
      },
      legacy: {
        tagCommit: LEGACY_COMMIT,
        release: rawRelease(
          intent,
          'legacy',
          intent.expected.assets.slice(0, 2),
        ),
        latest: intent.prePublicLatest.latest.legacy,
      },
    };
    mutate(intent, states);
    const calls = [];
    await expect(
      cleanupPartialDraftCreation({
        adapter: cleanupAdapter(states, calls),
        endpoints: endpoints(),
        intent,
      }),
    ).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });
});
