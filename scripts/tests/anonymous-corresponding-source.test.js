import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyRelease } from '../verify-anonymous-github-release-assets.mjs';

const roots = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture({ sourceBytes = 'source', sourceStatus = 200 } = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'otto-anonymous-source-'),
  );
  roots.push(directory);
  const canonical = 'NSIETeam/otto-new';
  const legacy = 'Felix201209/otto-releases';
  const tag = 'v1.9.15';
  const archive = 'otto-1.9.15-corresponding-source.tar.gz';
  const releaseBase = `https://github.com/${canonical}/releases/download/${tag}`;
  const manifest = {
    version: '1.9.15',
    assets: Object.fromEntries(
      ['mac-arm64', 'mac-x64', 'win-x64'].map((platform) => [
        platform,
        { name: `${platform}.bin`, url: `${releaseBase}/${platform}.bin` },
      ]),
    ),
  };
  const bodies = new Map([
    ['latest.json', JSON.stringify(manifest)],
    [archive, 'source'],
    [`${archive}.sha256`, 'checksum'],
  ]);
  for (const platform of Object.keys(manifest.assets)) {
    bodies.set(`${platform}.bin`, 'binary');
    bodies.set(`${platform}.bin.blockmap`, 'blockmap');
  }
  for (const [name, bytes] of bodies)
    await writeFile(path.join(directory, name), bytes);
  const calls = [];
  vi.stubGlobal('fetch', async (input, options) => {
    const url = new URL(input);
    calls.push({ url: url.href, options });
    if (url.hostname === 'api.github.com')
      return Response.json({
        full_name: url.pathname.slice('/repos/'.length),
        private: false,
        visibility: 'public',
      });
    const name = url.pathname.split('/').at(-1);
    if (name === archive)
      return new Response(sourceBytes, { status: sourceStatus });
    if (!bodies.has(name)) throw new Error('Unexpected fetch');
    return new Response(bodies.get(name));
  });
  return { directory, canonical, legacy, tag, archive, calls };
}

describe('anonymous corresponding-source delivery', () => {
  it.each(['canonical', 'legacy'])(
    'checks both source assets at the actual %s release, without credentials',
    async (repository) => {
      const options = await fixture();
      await verifyRelease(
        options[repository],
        options.canonical,
        options.tag,
        options.directory,
      );
      for (const suffix of ['', '.sha256']) {
        expect(options.calls.map(({ url }) => url)).toContain(
          `https://github.com/${options[repository]}/releases/download/${options.tag}/${options.archive}${suffix}`,
        );
      }
      for (const { options: request } of options.calls) {
        expect(request.credentials).toBe('omit');
        expect(
          Object.keys(request.headers).map((key) => key.toLowerCase()),
        ).not.toContain('authorization');
        expect(
          Object.keys(request.headers).map((key) => key.toLowerCase()),
        ).not.toContain('cookie');
      }
    },
  );
  it('rejects a source archive whose anonymous bytes differ from the locked artifact', async () => {
    const options = await fixture({ sourceBytes: 'changed-source' });
    await expect(
      verifyRelease(
        options.canonical,
        options.canonical,
        options.tag,
        options.directory,
      ),
    ).rejects.toThrow('asset mismatch');
  });
  it('rejects source that requires authentication even when every installer is public', async () => {
    const options = await fixture({ sourceStatus: 401 });
    await expect(
      verifyRelease(
        options.canonical,
        options.canonical,
        options.tag,
        options.directory,
      ),
    ).rejects.toThrow('401');
  });
});
