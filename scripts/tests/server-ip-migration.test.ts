/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTERPRISE_SERVER_URL } from '../../packages/desktop/src/main/enterprise-server-url.js';
import { DEFAULT_ENTERPRISE_PUBLIC_URL } from '../../packages/server/src/modules/identity_organization/publicInvite.js';
import { TRUSTED_ORIGINS } from '../../packages/server/src/protocol.js';
import {
  GITHUB_MANIFEST_URL,
  LEGACY_GITHUB_MANIFEST_URL,
  PRIMARY_MANIFEST_URL,
  resolveManifestAssetOrigins,
} from '../../packages/desktop/src/main/update-sources.js';
import { parseManifest } from '../../packages/desktop/src/main/update-core.js';
import { DEFAULT_UPDATE_ASSET_BASE_URL } from '../../packages/desktop/scripts/update-mirror-config.mjs';

const origin = 'https://101.200.190.204:7777';
const oldOrigin = 'https://59.110.154.44:7777';
const read = (relative: string) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

describe('fleet server migration contract', () => {
  it('aligns login, invitation, update, installer and release workflow defaults', () => {
    expect(DEFAULT_ENTERPRISE_SERVER_URL).toBe(origin);
    expect(DEFAULT_ENTERPRISE_PUBLIC_URL).toBe(origin);
    expect(PRIMARY_MANIFEST_URL).toBe(`${origin}/otto-releases/latest.json`);
    expect(DEFAULT_UPDATE_ASSET_BASE_URL).toBe(`${origin}/downloads`);
    const desktop = JSON.parse(read('packages/desktop/package.json'));
    expect(desktop.build.publish).toEqual([{ provider: 'generic', url: `${origin}/downloads` }]);
    const release = read('.github/workflows/release.yml');
    expect(release).toContain(`UPDATE_MIRROR_ASSET_BASE_URL: '${origin}/downloads'`);
    expect(release).toContain(`UPDATE_MIRROR_MANIFEST_URL: '${origin}/otto-releases/latest.json'`);
    expect(release).not.toContain(oldOrigin);
  });

  it('trusts the new website for local discovery and retires the old origin', () => {
    expect(TRUSTED_ORIGINS.has(origin)).toBe(true);
    expect(TRUSTED_ORIGINS.has(oldOrigin)).toBe(false);
    expect(TRUSTED_ORIGINS.has(`${origin}.evil.example`)).toBe(false);
    expect(TRUSTED_ORIGINS.has('http://localhost:3000')).toBe(true);
  });

  it.each([GITHUB_MANIFEST_URL, LEGACY_GITHUB_MANIFEST_URL])(
    'no longer accepts downloads from the retired mirror in %s', (manifestUrl) => {
      const parsed = parseManifest({ version: '9.8.7', assets: {
        'win-x64': { name: 'Otto-Setup-9.8.7-win-x64.exe',
          url: `${oldOrigin}/downloads/Otto-Setup-9.8.7-win-x64.exe`,
          size: 128, sha256: 'a'.repeat(64) },
      } }, resolveManifestAssetOrigins(manifestUrl));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.manifest.assets).toEqual({});
    },
  );

  it('does not expand the allow-list of an independently configured mirror', () => {
    expect(resolveManifestAssetOrigins('https://updates.example.com/latest.json'))
      .toEqual(['https://updates.example.com']);
  });
});
