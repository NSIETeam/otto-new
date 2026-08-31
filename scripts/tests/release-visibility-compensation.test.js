import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildExpectedPublication,
  compensateReleaseVisibility,
  normalizeReleaseState,
  parseCompensationCli,
  parsePrePublicationLatestSnapshot,
  ReleaseVisibilityCompensationError,
  verifyPrePublicationLatest,
} from '../release-visibility-compensation.mjs';

const TAG = 'v1.9.14';
const SOURCE_COMMIT = 'a'.repeat(40);
const LEGACY_COMMIT = 'd'.repeat(40);
const PACKAGE_IDENTITY = '1'.repeat(12) + '-' + '2'.repeat(12);

function rawRelease({
  id,
  repository,
  target,
  draft = false,
  prerelease = false,
}) {
  return {
    id,
    node_id: `release-${id}`,
    url: `https://api.github.com/repos/${repository}/releases/${id}`,
    tag_name: TAG,
    target_commitish: target,
    name: 'Otto v1.9.14',
    body: `Source commit: ${SOURCE_COMMIT}`,
    draft,
    prerelease,
    assets: [
      {
        id: id * 100 + 1,
        name: 'Otto-1.9.14-x64.dmg',
        label: '',
        state: 'uploaded',
        content_type: 'application/octet-stream',
        size: 1234,
        digest: `sha256:${'b'.repeat(64)}`,
      },
      {
        id: id * 100 + 2,
        name: 'SHA256SUMS',
        label: '',
        state: 'uploaded',
        content_type: 'text/plain',
        size: 256,
        digest: `sha256:${'c'.repeat(64)}`,
      },
    ],
  };
}

function fixtureStates(visibility = {}) {
  const latestFor = (key, state) =>
    state?.draft || state?.prerelease
      ? { id: key === 'canonical' ? 1 : 2, tag_name: 'v1.9.13' }
      : { id: key === 'canonical' ? 11 : 22, tag_name: TAG };
  return {
    canonical: normalizeReleaseState({
      repository: 'NSIETeam/otto-new',
      release: rawRelease({
        id: 11,
        repository: 'NSIETeam/otto-new',
        target: SOURCE_COMMIT,
        ...visibility.canonical,
      }),
      canonicalTagCommit: SOURCE_COMMIT,
      latestRelease: latestFor('canonical', visibility.canonical),
    }),
    legacy: normalizeReleaseState({
      repository: 'Felix201209/otto-releases',
      release: rawRelease({
        id: 22,
        repository: 'Felix201209/otto-releases',
        target: LEGACY_COMMIT,
        ...visibility.legacy,
      }),
      latestRelease: latestFor('legacy', visibility.legacy),
    }),
  };
}

function clone(value) {
  return structuredClone(value);
}

function expected(states = fixtureStates()) {
  return {
    tag: TAG,
    canonicalTarget: SOURCE_COMMIT,
    legacyTarget: LEGACY_COMMIT,
    canonicalTagCommit: SOURCE_COMMIT,
    releaseName: 'Otto v1.9.14',
    bodySha256: states.canonical.identity.bodySha256,
    prerelease: states.canonical.visibility.prerelease,
    assets: states.canonical.assets.map(({ name, size, digest }) => ({
      name,
      size,
      digest,
    })),
  };
}

function endpoints() {
  return {
    canonical: { key: 'canonical', repository: 'NSIETeam/otto-new' },
    legacy: { key: 'legacy', repository: 'Felix201209/otto-releases' },
  };
}

function prePublicationLatest(latest = {}) {
  return {
    format: 'otto-pre-public-latest-v1',
    tag: TAG,
    canonicalRepository: 'NSIETeam/otto-new',
    legacyRepository: 'Felix201209/otto-releases',
    canonicalCommit: SOURCE_COMMIT,
    latest: {
      canonical:
        latest.canonical === undefined
          ? { id: 1, tagName: 'v1.9.13' }
          : latest.canonical,
      legacy:
        latest.legacy === undefined
          ? { id: 2, tagName: 'v1.9.13' }
          : latest.legacy,
    },
  };
}

function withLatestControl(states, adapter, options = {}) {
  const previous = {
    canonical: options.canonicalPrevious ?? { id: 1, tagName: 'v1.9.13' },
    legacy: options.legacyPrevious ?? { id: 2, tagName: 'v1.9.13' },
  };
  return {
    ...adapter,
    async getLatest(endpoint) {
      return clone(states[endpoint.key].latest);
    },
    async getReleasePointer(endpoint, releaseId) {
      const pointer = previous[endpoint.key];
      return pointer?.id === releaseId
        ? { ...clone(pointer), draft: false, prerelease: false }
        : null;
    },
    async setLatest(endpoint, releaseId) {
      const pointer = previous[endpoint.key];
      if (!pointer || pointer.id !== releaseId) {
        throw new Error(`unknown previous latest release: ${releaseId}`);
      }
      states[endpoint.key].latest = clone(pointer);
      options.onSetLatest?.(endpoint, releaseId);
    },
  };
}

function applyVisibility(states, endpoint, visibility) {
  states[endpoint.key].visibility = {
    draft: visibility.draft,
    prerelease: visibility.prerelease,
  };
  if (visibility.makeLatest) {
    states[endpoint.key].latest = {
      id: states[endpoint.key].identity.id,
      tagName: states[endpoint.key].identity.tagName,
    };
  } else if (
    states[endpoint.key].latest?.id === states[endpoint.key].identity.id
  ) {
    states[endpoint.key].latest = {
      id: endpoint.key === 'canonical' ? 1 : 2,
      tagName: 'v1.9.13',
    };
  }
}

describe('release visibility compensation', () => {
  it('requires an exact legacy commit SHA in compensation CLI bindings', () => {
    const argv = [
      '--tag',
      TAG,
      '--canonical-repo',
      'NSIETeam/otto-new',
      '--legacy-repo',
      'Felix201209/otto-releases',
      '--canonical-commit',
      SOURCE_COMMIT,
      '--canonical-target',
      SOURCE_COMMIT,
      '--legacy-target',
      LEGACY_COMMIT,
      '--artifact-dir',
      'release-download',
      '--package-identity',
      PACKAGE_IDENTITY,
      '--expected-prerelease',
      'false',
      '--pre-public-latest-snapshot',
      'release-state/pre-public-latest.json',
      '--pre-public-latest-sha256',
      'f'.repeat(64),
    ];

    expect(parseCompensationCli(argv).legacyTarget).toBe(LEGACY_COMMIT);
    expect(() =>
      parseCompensationCli(
        argv.map((value) => (value === LEGACY_COMMIT ? 'main' : value)),
      ),
    ).toThrow('arguments are invalid');
  });

  it('derives the exact 14-asset publication identity from the immutable artifact', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'otto-release-compensation-'),
    );
    try {
      const nested = path.join(root, 'nested');
      await mkdir(nested);
      const names = [
        'Otto-1.9.14-arm64.dmg',
        'Otto-1.9.14-arm64.dmg.blockmap',
        'Otto-1.9.14-x64.dmg',
        'Otto-1.9.14-x64.dmg.blockmap',
        'Otto-Setup-1.9.14-win-x64.exe',
        'Otto-Setup-1.9.14-win-x64.exe.blockmap',
        'latest.json',
        'SHA256SUMS',
        'SHA256SUMS.sig',
        'UPDATE-MIRROR-SHA256SUMS',
        'UPDATE-MIRROR-SHA256SUMS.sig',
        `otto-enterprise-oneclick-v1.9.14-${PACKAGE_IDENTITY}.tar.gz`,
        `otto-enterprise-oneclick-v1.9.14-${PACKAGE_IDENTITY}.tar.gz.sha256`,
        `otto-enterprise-oneclick-v1.9.14-${PACKAGE_IDENTITY}.tar.gz.sig`,
      ];
      await Promise.all(
        names.map((name, index) =>
          writeFile(
            path.join(index % 2 === 0 ? root : nested, name),
            `asset-${index}`,
          ),
        ),
      );
      await writeFile(path.join(root, 'release-notes.md'), 'locked notes\n');

      const expectedPublication = await buildExpectedPublication({
        artifactDirectory: root,
        version: '1.9.14',
        packageIdentity: PACKAGE_IDENTITY,
        prerelease: false,
      });

      expect(expectedPublication.releaseName).toBe('Otto v1.9.14');
      expect(expectedPublication.prerelease).toBe(false);
      expect(expectedPublication.assets).toHaveLength(14);
      expect(expectedPublication.assets.map(({ name }) => name).sort()).toEqual(
        [...names].sort(),
      );
      expect(expectedPublication.assets.every(({ size }) => size > 0)).toBe(
        true,
      );
      expect(
        expectedPublication.assets.every(({ digest }) =>
          /^sha256:[0-9a-f]{64}$/.test(digest),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps both observed releases public while restoring the exact previous latest pointers', async () => {
    const states = fixtureStates();
    const calls = [];
    const adapter = withLatestControl(states, {
      async getState(endpoint) {
        calls.push(`get:${endpoint.key}`);
        return clone(states[endpoint.key]);
      },
      async setVisibility(endpoint, releaseId, visibility) {
        calls.push(
          `set:${endpoint.key}:${visibility.draft}:${visibility.prerelease}:${visibility.makeLatest}`,
        );
        expect(releaseId).toBe(states[endpoint.key].identity.id);
        applyVisibility(states, endpoint, visibility);
      },
    });

    const result = await compensateReleaseVisibility({
      adapter,
      endpoints: endpoints(),
      expected: expected(states),
      prePublicationLatest: prePublicationLatest(),
    });

    expect(result.finalStates.canonical.visibility).toEqual({
      draft: false,
      prerelease: false,
    });
    expect(result.finalStates.legacy.visibility).toEqual({
      draft: false,
      prerelease: false,
    });
    expect(calls.slice(0, 2)).toEqual(['get:canonical', 'get:legacy']);
    expect(calls).toContain('set:canonical:false:false:false');
    expect(calls).toContain('set:legacy:false:false:false');
    expect(calls).not.toContain('set:canonical:true:false:false');
    expect(calls).not.toContain('set:legacy:true:false:false');
    expect(result.finalStates.canonical.latest.tagName).toBe('v1.9.13');
    expect(result.finalStates.legacy.latest.tagName).toBe('v1.9.13');
  });

  it('keeps observed prereleases public and never promotes them to latest', async () => {
    const states = fixtureStates({
      canonical: { draft: false, prerelease: true },
      legacy: { draft: false, prerelease: true },
    });
    const calls = [];
    const adapter = withLatestControl(states, {
      async getState(endpoint) {
        return clone(states[endpoint.key]);
      },
      async setVisibility(endpoint, releaseId, visibility) {
        expect(releaseId).toBe(states[endpoint.key].identity.id);
        calls.push(
          `set:${endpoint.key}:${visibility.draft}:${visibility.prerelease}:${visibility.makeLatest}`,
        );
        applyVisibility(states, endpoint, visibility);
      },
    });

    const result = await compensateReleaseVisibility({
      adapter,
      endpoints: endpoints(),
      expected: expected(states),
      prePublicationLatest: prePublicationLatest(),
    });

    expect(result.finalStates.canonical.visibility).toEqual({
      draft: false,
      prerelease: true,
    });
    expect(result.finalStates.legacy.visibility).toEqual({
      draft: false,
      prerelease: true,
    });
    expect(result.finalStates.canonical.latest.tagName).toBe('v1.9.13');
    expect(result.finalStates.legacy.latest.tagName).toBe('v1.9.13');
    expect(calls).toContain('set:canonical:false:true:false');
    expect(calls).toContain('set:legacy:false:true:false');
    expect(calls.some((call) => call.includes(':true:true:'))).toBe(false);
  });

  it('resumes after a crash left canonical compensated and legacy still latest', async () => {
    const states = fixtureStates();
    states.canonical.latest = { id: 1, tagName: 'v1.9.13' };
    const calls = [];
    const adapter = withLatestControl(states, {
      async getState(endpoint) {
        return clone(states[endpoint.key]);
      },
      async setVisibility(endpoint, releaseId, visibility) {
        expect(releaseId).toBe(states[endpoint.key].identity.id);
        calls.push(
          `set:${endpoint.key}:${visibility.draft}:${visibility.prerelease}:${visibility.makeLatest}`,
        );
        applyVisibility(states, endpoint, visibility);
      },
    });

    const result = await compensateReleaseVisibility({
      adapter,
      endpoints: endpoints(),
      expected: expected(states),
      prePublicationLatest: prePublicationLatest(),
    });

    expect(result.finalStates.canonical.latest).toEqual({
      id: 1,
      tagName: 'v1.9.13',
    });
    expect(result.finalStates.legacy.latest).toEqual({
      id: 2,
      tagName: 'v1.9.13',
    });
    expect(calls).toContain('set:canonical:false:false:false');
    expect(calls).toContain('set:legacy:false:false:false');
  });

  it('restores initial both-public latest pointers after canonical verify loss and legacy mutation failure', async () => {
    const states = fixtureStates();
    const calls = [];
    let loseCanonicalPointerVerify = true;
    const adapter = withLatestControl(states, {
      async getState(endpoint) {
        calls.push(`get:${endpoint.key}`);
        if (
          endpoint.key === 'canonical' &&
          states.canonical.latest?.id !== states.canonical.identity.id &&
          loseCanonicalPointerVerify
        ) {
          loseCanonicalPointerVerify = false;
          throw new Error('canonical final verify response was lost');
        }
        return clone(states[endpoint.key]);
      },
      async setVisibility(endpoint, releaseId, visibility) {
        calls.push(
          `set:${endpoint.key}:${visibility.draft}:${visibility.prerelease}:${visibility.makeLatest}`,
        );
        expect(releaseId).toBe(states[endpoint.key].identity.id);
        if (endpoint.key === 'legacy' && !visibility.makeLatest) {
          throw new Error('legacy latest-pointer mutation failed');
        }
        applyVisibility(states, endpoint, visibility);
      },
    });

    let failure;
    try {
      await compensateReleaseVisibility({
        adapter,
        endpoints: endpoints(),
        expected: expected(states),
        prePublicationLatest: prePublicationLatest(),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ReleaseVisibilityCompensationError);
    expect(failure.restored).toBe(true);
    expect(states.canonical.visibility).toEqual({
      draft: false,
      prerelease: false,
    });
    expect(states.legacy.visibility).toEqual({
      draft: false,
      prerelease: false,
    });
    expect(states.canonical.latest).toEqual({ id: 11, tagName: TAG });
    expect(states.legacy.latest).toEqual({ id: 22, tagName: TAG });
    expect(calls).toContain('set:canonical:false:false:false');
    expect(calls).toContain('set:legacy:false:false:false');
    expect(calls).toContain('set:canonical:false:false:true');
    expect(calls).toContain('set:legacy:false:false:true');
  });

  it('restores each endpoint to its own pre-compensation visibility vector', async () => {
    const states = fixtureStates({
      canonical: { draft: false, prerelease: false },
      legacy: { draft: true, prerelease: false },
    });
    const original = clone(states);
    let loseLegacyResponse = true;
    const adapter = withLatestControl(states, {
      async getState(endpoint) {
        return clone(states[endpoint.key]);
      },
      async setVisibility(endpoint, _releaseId, visibility) {
        applyVisibility(states, endpoint, visibility);
        if (endpoint.key === 'legacy' && loseLegacyResponse) {
          loseLegacyResponse = false;
          throw new Error('legacy latest-pointer response lost');
        }
      },
    });

    await expect(
      compensateReleaseVisibility({
        adapter,
        endpoints: endpoints(),
        expected: expected(original),
        prePublicationLatest: prePublicationLatest(),
      }),
    ).rejects.toMatchObject({ restored: true });

    expect(states.canonical.visibility).toEqual(original.canonical.visibility);
    expect(states.legacy.visibility).toEqual(original.legacy.visibility);
    expect(states.canonical.latest).toEqual(original.canonical.latest);
    expect(states.legacy.latest).toEqual(original.legacy.latest);
  });

  it('blocks before mutation when the canonical tag commit is not exact', async () => {
    const states = fixtureStates();
    states.canonical.canonicalTagCommit = 'd'.repeat(40);
    let mutations = 0;
    const adapter = withLatestControl(states, {
      async getState(endpoint) {
        return clone(states[endpoint.key]);
      },
      async setVisibility() {
        mutations += 1;
      },
    });

    await expect(
      compensateReleaseVisibility({
        adapter,
        endpoints: endpoints(),
        expected: expected(states),
        prePublicationLatest: prePublicationLatest(),
      }),
    ).rejects.toThrow('release identity does not match');
    expect(mutations).toBe(0);
  });

  it.each([
    [
      'release name',
      (states) => {
        states.legacy.identity.name = 'Wrong release';
      },
    ],
    [
      'release notes',
      (states) => {
        states.canonical.identity.bodySha256 = 'f'.repeat(64);
      },
    ],
    [
      'asset vector',
      (states) => {
        states.legacy.assets[0].size += 1;
      },
    ],
    [
      'latest pointer',
      (states) => {
        states.canonical.latest = { id: 99, tagName: 'v1.9.12' };
      },
    ],
  ])(
    'blocks before mutation when the %s is not locked',
    async (_label, mutate) => {
      const baseline = fixtureStates();
      const lockedExpected = expected(baseline);
      const states = clone(baseline);
      mutate(states);
      let mutations = 0;
      const adapter = withLatestControl(states, {
        async getState(endpoint) {
          return clone(states[endpoint.key]);
        },
        async setVisibility() {
          mutations += 1;
        },
      });

      await expect(
        compensateReleaseVisibility({
          adapter,
          endpoints: endpoints(),
          expected: lockedExpected,
          prePublicationLatest: prePublicationLatest(),
        }),
      ).rejects.toThrow();
      expect(mutations).toBe(0);
    },
  );

  it('rechecks both locked snapshots immediately before the first mutation', async () => {
    const states = fixtureStates();
    const lockedExpected = expected(states);
    let reads = 0;
    let mutations = 0;
    const adapter = withLatestControl(states, {
      async getState(endpoint) {
        reads += 1;
        const observed = clone(states[endpoint.key]);
        if (reads === 3 && endpoint.key === 'canonical') {
          observed.identity.bodySha256 = 'e'.repeat(64);
        }
        return observed;
      },
      async setVisibility() {
        mutations += 1;
      },
    });

    await expect(
      compensateReleaseVisibility({
        adapter,
        endpoints: endpoints(),
        expected: lockedExpected,
        prePublicationLatest: prePublicationLatest(),
      }),
    ).rejects.toThrow('release state diverged');
    expect(mutations).toBe(0);
  });

  it('restores the exact pre-public latest release instead of GitHub automatic fallback', async () => {
    const states = fixtureStates();
    const restored = [];
    const prior = prePublicationLatest({
      canonical: { id: 91, tagName: 'v1.9.12' },
      legacy: { id: 92, tagName: 'v1.9.12' },
    });
    const adapter = withLatestControl(
      states,
      {
        async getState(endpoint) {
          return clone(states[endpoint.key]);
        },
        async setVisibility(endpoint, _releaseId, visibility) {
          states[endpoint.key].visibility = {
            draft: visibility.draft,
            prerelease: visibility.prerelease,
          };
          if (visibility.draft) {
            states[endpoint.key].latest = {
              id: endpoint.key === 'canonical' ? 81 : 82,
              tagName: 'v1.9.13',
            };
          }
        },
      },
      {
        canonicalPrevious: prior.latest.canonical,
        legacyPrevious: prior.latest.legacy,
        onSetLatest(endpoint) {
          restored.push(endpoint.key);
        },
      },
    );

    const result = await compensateReleaseVisibility({
      adapter,
      endpoints: endpoints(),
      expected: expected(states),
      prePublicationLatest: prior,
    });

    expect(restored).toEqual(['canonical', 'legacy']);
    expect(result.finalStates.canonical.latest).toEqual(prior.latest.canonical);
    expect(result.finalStates.legacy.latest).toEqual(prior.latest.legacy);
  });

  it('blocks before mutation when the recorded previous latest release was replaced', async () => {
    const states = fixtureStates();
    let mutations = 0;
    const adapter = withLatestControl(
      states,
      {
        async getState(endpoint) {
          return clone(states[endpoint.key]);
        },
        async setVisibility() {
          mutations += 1;
        },
      },
      {
        canonicalPrevious: { id: 1, tagName: 'v1.9.12' },
      },
    );

    await expect(
      compensateReleaseVisibility({
        adapter,
        endpoints: endpoints(),
        expected: expected(states),
        prePublicationLatest: prePublicationLatest(),
      }),
    ).rejects.toThrow('pre-public latest release changed');
    expect(mutations).toBe(0);
  });

  it('validates the immutable pre-public latest snapshot digest and binding', () => {
    const snapshot = `${JSON.stringify(prePublicationLatest(), null, 2)}\n`;
    const digest = createHash('sha256').update(snapshot).digest('hex');

    expect(
      parsePrePublicationLatestSnapshot(snapshot, {
        sha256: digest,
        tag: TAG,
        canonicalRepository: 'NSIETeam/otto-new',
        legacyRepository: 'Felix201209/otto-releases',
        canonicalCommit: SOURCE_COMMIT,
      }),
    ).toEqual(prePublicationLatest());

    expect(() =>
      parsePrePublicationLatestSnapshot(snapshot, {
        sha256: '0'.repeat(64),
        tag: TAG,
        canonicalRepository: 'NSIETeam/otto-new',
        legacyRepository: 'Felix201209/otto-releases',
        canonicalCommit: SOURCE_COMMIT,
      }),
    ).toThrow('snapshot digest');
  });

  it('rechecks both exact latest pointers before publication', async () => {
    const snapshot = prePublicationLatest();
    let reads = 0;
    const adapter = {
      async getLatest(endpoint) {
        reads += 1;
        if (reads === 3 && endpoint.key === 'canonical') {
          return { id: 99, tagName: 'v1.9.12' };
        }
        return clone(snapshot.latest[endpoint.key]);
      },
    };

    await expect(
      verifyPrePublicationLatest({
        adapter,
        endpoints: endpoints(),
        snapshot,
        expected: {
          tag: TAG,
          canonicalRepository: 'NSIETeam/otto-new',
          legacyRepository: 'Felix201209/otto-releases',
          canonicalCommit: SOURCE_COMMIT,
        },
      }),
    ).rejects.toThrow('not restored exactly');
  });
});
