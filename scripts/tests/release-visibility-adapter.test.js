import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  const execFile = () => { throw new Error('Callback transport is not used'); };
  execFile[Symbol.for('nodejs.util.promisify.custom')] = transport;
  return { ...actual, execFile };
});
import { createGitHubAdapter } from '../release-visibility-compensation.mjs';

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
