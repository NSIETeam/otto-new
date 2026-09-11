import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  const execFile = () => { throw new Error('Callback transport is not used'); };
  execFile[Symbol.for('nodejs.util.promisify.custom')] = transport;
  return { ...actual, execFile };
});
import { compensateReleaseVisibility, createGitHubAdapter } from '../release-visibility-compensation.mjs';

const repository = 'NSIETeam/otto-new';
const tag = 'v1.9.15';
const source = 'a'.repeat(40);
const endpoint = { key: 'canonical', repository };
const asset = { id: 101, name: 'package.tar.gz', label: '', state: 'uploaded',
  content_type: 'application/octet-stream', size: 99, digest: `sha256:${'b'.repeat(64)}` };
function fixture(overrides = {}) {
  const release = { id: 42, node_id: 'release-42', url: `https://api.github.com/repos/${repository}/releases/42`,
    tag_name: tag, target_commitish: source, name: 'Otto v1.9.15', body: 'locked release',
    draft: true, prerelease: false, assets: [asset], ...overrides.release };
  const pages = overrides.pages ?? [[{ id: 1, tag_name: `${tag}-rc.1` }], [release]];
  transport.mockImplementation(async (executable, args, options) => {
    expect(executable).toBe('gh');
    expect(options.env.GH_TOKEN).toBe('fixture-token-not-a-secret');
    expect(args.slice(0, 3)).toEqual(['api', '--method', 'GET']);
    const route = args[3];
    let value;
    if (route === `repos/${repository}/releases/tags/${tag}`) {
      throw Object.assign(new Error('GitHub tag endpoint excludes unpublished drafts'), { stderr: 'HTTP 404' });
    } else if (route === `repos/${repository}/releases?per_page=100`) {
      expect(args).toContain('--paginate'); expect(args).toContain('--slurp'); value = pages;
    } else if (route === `repos/${repository}/releases/42`) value = overrides.detail ?? release;
    else if (route === `repos/${repository}/releases/42/assets?per_page=100`) {
      expect(args).toContain('--paginate'); expect(args).toContain('--slurp'); value = overrides.assets ?? [[asset]];
    } else if (route === `repos/${repository}/git/matching-refs/tags/${tag}`) {
      if (overrides.refError) throw overrides.refError;
      expect(args).toContain('--paginate'); expect(args).toContain('--slurp');
      value = [overrides.refs ?? []];
    } else if (route === `repos/${repository}/commits/${tag}`) return { stdout: `${source}\n` };
    else if (route === `repos/${repository}`) return { stdout: `${repository}\n` };
    else if (route === `repos/${repository}/releases/latest`) value = { id: 7, tag_name: 'v1.9.14' };
    else throw new Error(`Unexpected read-only route: ${route}`);
    return { stdout: JSON.stringify(value) };
  });
  return createGitHubAdapter({ tag, tokens: { canonical: 'fixture-token-not-a-secret' } });
}
beforeEach(() => { transport.mockReset(); });
describe('GitHub visibility adapter observes unpublished drafts', () => {
  it('finds the exact draft across pages without inventing a nonexistent tag commit', async () => {
    const state = await fixture().getState(endpoint);
    expect(state.identity.id).toBe(42);
    expect(state.visibility.draft).toBe(true);
    expect(state.canonicalTagCommit).toBeNull();
    expect(state.assets).toHaveLength(1);
    expect(state.latest).toEqual({ id: 7, tagName: 'v1.9.14' });
  });
  it('resolves a real exact tag, ignoring prefix matches', async () => {
    const refs = [{ ref: `refs/tags/${tag}-rc.1` }, { ref: `refs/tags/${tag}` }];
    const state = await fixture({ release: { draft: false }, refs }).getState(endpoint);
    expect(state.canonicalTagCommit).toBe(source);
  });
  it('refuses ambiguous duplicate release tags', async () => {
    await expect(fixture({ pages: [[{ id: 42, tag_name: tag }], [{ id: 43, tag_name: tag }]] }).getState(endpoint)).rejects.toThrow(/unique|ambiguous/i);
  });
  it('refuses a release retagged between listing and identity read', async () => {
    await expect(fixture({ detail: { id: 42, tag_name: 'v9.9.9' } }).getState(endpoint)).rejects.toThrow(/identity|tag/i);
  });
  it('refuses an ID mismatch before reading assets', async () => {
    await expect(fixture({ detail: { id: 43, tag_name: tag } }).getState(endpoint)).rejects.toThrow(/identity/i);
  });
  it('does not turn a missing public tag into evidence of a valid publication', async () => {
    await expect(fixture({ release: { draft: false } }).getState(endpoint)).rejects.toThrow(/tag/i);
  });
  it('does not treat authentication failure as tag absence', async () => {
    await expect(fixture({ refError: new Error('HTTP 403') }).getState(endpoint)).rejects.toThrow('HTTP 403');
  });
  it('does not accept malformed paginated release responses', async () => {
    await expect(fixture({ pages: [{ releases: [] }] }).getState(endpoint)).rejects.toThrow(/page|response/i);
  });
  it('validates assets from the complete asset endpoint rather than the embedded list', async () => {
    const state = await fixture({ release: { assets: [] }, assets: [[asset], [{ ...asset, id: 102, name: 'checksums' }]] }).getState(endpoint);
    expect(state.assets).toHaveLength(2);
  });
  it('refuses duplicate exact tag refs', async () => {
    await expect(fixture({ refs: [{ ref: `refs/tags/${tag}` }, { ref: `refs/tags/${tag}` }] }).getState(endpoint)).rejects.toThrow(/tag|ambiguous/i);
  });
});

// Exercise the real adapter and transaction together, mocking only GitHub HTTP.
// A draft PATCH without tag_name reproduces the observed untagged-* transition.
function compensationFixture({ publicCanonical = false, afterPatch } = {}) {
  const endpoints = {
    canonical: endpoint,
    legacy: { key: 'legacy', repository: 'Felix201209/otto-releases' },
  };
  const releases = {};
  const previous = {};
  const latest = {};
  const writes = [];
  for (const [index, key] of ['canonical', 'legacy'].entries()) {
    releases[key] = {
      id: 42 + index, node_id: `release-${42 + index}`,
      url: `https://api.github.com/repos/${endpoints[key].repository}/releases/${42 + index}`,
      tag_name: tag, target_commitish: key === 'canonical' ? source : 'c'.repeat(40),
      name: 'Otto v1.9.15', body: 'locked release',
      draft: key !== 'canonical' || !publicCanonical, prerelease: false,
      assets: [asset, { ...asset, id: 102, name: 'SHA256SUMS' }].map(item => ({ ...item, id: item.id + index * 100 })),
    };
    previous[key] = { id: 7 + index, tag_name: 'v1.9.14', draft: false, prerelease: false };
    latest[key] = key === 'canonical' && publicCanonical ? releases[key] : previous[key];
  }
  transport.mockImplementation(async (executable, args, options) => {
    expect(executable).toBe('gh');
    expect(options.env.GH_TOKEN).toBe('fixture-token-not-a-secret');
    const [api, methodFlag, method, route] = args;
    expect([api, methodFlag]).toEqual(['api', '--method']);
    const key = Object.keys(endpoints).find(name => route.startsWith(`repos/${endpoints[name].repository}`));
    if (!key) throw new Error(`Unexpected repository: ${route}`);
    const base = `repos/${endpoints[key].repository}`;
    const release = releases[key];
    if (method === 'PATCH') {
      const fields = {};
      for (let index = 4; index < args.length; index += 2) {
        expect(['-f', '-F']).toContain(args[index]);
        const separator = args[index + 1].indexOf('=');
        const name = args[index + 1].slice(0, separator);
        expect(fields).not.toHaveProperty(name);
        fields[name] = args[index + 1].slice(separator + 1);
      }
      writes.push({ key, route, fields });
      if (route === `${base}/releases/${release.id}`) {
        release.draft = fields.draft === 'true';
        release.prerelease = fields.prerelease === 'true';
        release.tag_name = fields.tag_name ?? (release.draft ? `untagged-${key}` : release.tag_name);
        if (fields.make_latest === 'true') latest[key] = release;
      } else if (route === `${base}/releases/${previous[key].id}`) {
        expect(fields).toEqual({ make_latest: 'true' });
        latest[key] = previous[key];
      } else throw new Error(`Unexpected PATCH identity: ${route}`);
      afterPatch?.({ key, route, release, previous: previous[key], latest });
      return { stdout: '{}' };
    }
    expect(method).toBe('GET');
    let value;
    if (route === base) return { stdout: endpoints[key].repository };
    if (route === `${base}/releases?per_page=100`) value = [[{ id: 1, tag_name: `${tag}-rc.1` }], [release]];
    else if (route === `${base}/releases/${release.id}`) value = release;
    else if (route === `${base}/releases/${previous[key].id}`) value = previous[key];
    else if (route === `${base}/releases/${release.id}/assets?per_page=100`) value = release.assets.map(item => [item]);
    else if (route === `${base}/git/matching-refs/tags/${tag}`) value = [publicCanonical ? [{ ref: `refs/tags/${tag}` }] : []];
    else if (route === `${base}/commits/${tag}`) return { stdout: source };
    else if (route === `${base}/releases/latest`) value = latest[key];
    else throw new Error(`Unexpected GET route: ${route}`);
    if (Array.isArray(value)) {
      expect(args).toContain('--paginate'); expect(args).toContain('--slurp');
    }
    return { stdout: JSON.stringify(value) };
  });
  return {
    releases, writes,
    run: () => compensateReleaseVisibility({
      adapter: createGitHubAdapter({ tag, tokens: { canonical: 'fixture-token-not-a-secret', legacy: 'fixture-token-not-a-secret' } }),
      endpoints,
      expected: {
        tag, canonicalTarget: source, legacyTarget: 'c'.repeat(40), canonicalTagCommit: source,
        releaseName: 'Otto v1.9.15', bodySha256: createHash('sha256').update('locked release').digest('hex'),
        prerelease: false,
        assets: ['package.tar.gz', 'SHA256SUMS'].map(name => ({ name, size: asset.size, digest: asset.digest })),
      },
      prePublicationLatest: {
        format: 'otto-pre-public-latest-v1', tag, canonicalRepository: repository,
        legacyRepository: endpoints.legacy.repository, canonicalCommit: source,
        latest: { canonical: { id: 7, tagName: 'v1.9.14' }, legacy: { id: 8, tagName: 'v1.9.14' } },
      },
    }),
  };
}

describe('GitHub visibility PATCH preserves the locked publication identity', () => {
  it.each([false, true])('compensates paginated drafts with publicCanonical=%s without retagging or retracting', async publicCanonical => {
    const test = compensationFixture({ publicCanonical });
    const before = structuredClone(test.releases);
    const { finalStates } = await test.run();
    expect(test.releases).toEqual(before);
    for (const [index, key] of ['canonical', 'legacy'].entries()) {
      expect(finalStates[key].identity.tagName).toBe(tag);
      expect(finalStates[key].latest).toEqual({ id: 7 + index, tagName: 'v1.9.14' });
      expect(finalStates[key].assets).toHaveLength(2);
    }
    expect(finalStates.canonical.canonicalTagCommit).toBe(publicCanonical ? source : null);
    expect(test.writes).toHaveLength(4);
    for (const write of test.writes.filter(item => item.fields.draft !== undefined)) {
      expect(write.route).toBe(`repos/${write.key === 'canonical' ? repository : 'Felix201209/otto-releases'}/releases/${test.releases[write.key].id}`);
      expect(write.fields).toEqual({ tag_name: tag, draft: String(test.releases[write.key].draft), prerelease: 'false', make_latest: 'false' });
    }
  });

  it.each(['retag', 'asset', 'old-latest'])('does not claim success when %s changes during the transaction', async kind => {
    const test = compensationFixture({ afterPatch: ({ release, previous }) => {
      if (kind === 'retag') release.tag_name = 'untagged-concurrent-change';
      if (kind === 'asset') release.assets[1].digest = `sha256:${'f'.repeat(64)}`;
      if (kind === 'old-latest') previous.tag_name = 'v9.9.9';
    } });
    await expect(test.run()).rejects.toMatchObject({ name: 'ReleaseVisibilityCompensationError', restored: false });
  });
});
