/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  FALLBACK_RELEASE_API_URL,
  GITHUB_MANIFEST_URL,
  LEGACY_GITHUB_MANIFEST_URL,
  OFFICIAL_UPDATE_MIRROR_ORIGIN,
  PRIMARY_MANIFEST_URL,
  RELEASE_PAGE_URL,
  resolveManifestAssetOrigins,
  resolveManifestUrls,
} from './update-sources.js';
import {
  compareVersions,
  parseManifest,
  platformAssetKey,
  resolveCheckOutcome,
} from './update-core.js';

describe('桌面应用更新源', () => {
  it('主源使用企业 HTTPS 镜像，避开 GitHub release 资产直链不稳定', () => {
    const url = new URL(PRIMARY_MANIFEST_URL);
    expect(url.protocol).toBe('https:');
    expect(url.origin).toBe('https://59.110.154.44:7777');
    expect(url.pathname).toBe('/otto-releases/latest.json');
  });

  it('GitHub 清单、兜底 API 与手动发布页指向新的源码与发布仓库', () => {
    expect(GITHUB_MANIFEST_URL).toBe(
      'https://github.com/NSIETeam/otto-new/releases/latest/download/latest.json',
    );
    expect(FALLBACK_RELEASE_API_URL).toBe(
      'https://api.github.com/repos/NSIETeam/otto-new/releases/latest',
    );
    expect(RELEASE_PAGE_URL).toBe(
      'https://github.com/NSIETeam/otto-new/releases/latest',
    );
  });

  it('保留旧发布仓清单作为已安装旧版本的兼容入口', () => {
    expect(LEGACY_GITHUB_MANIFEST_URL).toBe(
      'https://github.com/Felix201209/otto-releases/releases/latest/download/latest.json',
    );
  });

  it.each([GITHUB_MANIFEST_URL, LEGACY_GITHUB_MANIFEST_URL])(
    '允许官方 GitHub 清单继续引用固定更新镜像资产：%s',
    (manifestUrl) => {
      const allowedOrigins = resolveManifestAssetOrigins(manifestUrl);
      expect(allowedOrigins).toEqual([OFFICIAL_UPDATE_MIRROR_ORIGIN]);

      const parsed = parseManifest(
        {
          version: '1.9.14',
          assets: {
            'win-x64': {
              name: 'Otto-Setup-1.9.14-win-x64.exe',
              url: `${OFFICIAL_UPDATE_MIRROR_ORIGIN}/downloads/Otto-Setup-1.9.14-win-x64.exe`,
              size: 128,
              sha256: 'a'.repeat(64),
            },
          },
        },
        allowedOrigins,
      );

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.manifest.assets['win-x64']?.name).toBe(
        'Otto-Setup-1.9.14-win-x64.exe',
      );
    },
  );

  it.each([
    ['Windows x64', 'win32', 'x64', 'win-x64'],
    ['macOS Apple Silicon', 'darwin', 'arm64', 'mac-arm64'],
    ['macOS Intel', 'darwin', 'x64', 'mac-x64'],
  ])(
    '让 V1.9.13 从 mirror/canonical/legacy 清单选择 V1.9.14 的正确 %s 资产',
    (_label, platform, arch, expectedKey) => {
      expect(compareVersions('1.9.13', '1.9.14')).toBe(-1);
      const assetKey = platformAssetKey(platform, arch);
      expect(assetKey).toBe(expectedKey);
      const assets = {
        'win-x64': {
          name: 'Otto-Setup-1.9.14-win-x64.exe',
          url: `${OFFICIAL_UPDATE_MIRROR_ORIGIN}/downloads/Otto-Setup-1.9.14-win-x64.exe`,
          size: 913_914,
          sha256: 'A'.repeat(64),
        },
        'mac-arm64': {
          name: 'Otto-1.9.14-arm64.dmg',
          url: `${OFFICIAL_UPDATE_MIRROR_ORIGIN}/downloads/Otto-1.9.14-arm64.dmg`,
          size: 913_915,
          sha256: 'B'.repeat(64),
        },
        'mac-x64': {
          name: 'Otto-1.9.14-x64.dmg',
          url: `${OFFICIAL_UPDATE_MIRROR_ORIGIN}/downloads/Otto-1.9.14-x64.dmg`,
          size: 913_916,
          sha256: 'C'.repeat(64),
        },
      };

      for (const manifestUrl of [
        PRIMARY_MANIFEST_URL,
        GITHUB_MANIFEST_URL,
        LEGACY_GITHUB_MANIFEST_URL,
      ]) {
        const parsed = parseManifest(
          {
            version: '1.9.14',
            notes: 'V1.9.13 到 V1.9.14 升级验收',
            assets,
          },
          resolveManifestAssetOrigins(manifestUrl),
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.manifest.assets[expectedKey]?.sha256).toBe(
          assets[expectedKey as keyof typeof assets].sha256.toLowerCase(),
        );
        expect(
          resolveCheckOutcome(
            parsed.manifest,
            '1.9.13',
            assetKey,
            RELEASE_PAGE_URL,
          ),
        ).toMatchObject({
          status: 'update-available',
          currentVersion: '1.9.13',
          version: '1.9.14',
          asset: {
            name: assets[expectedKey as keyof typeof assets].name,
            sha256:
              assets[expectedKey as keyof typeof assets].sha256.toLowerCase(),
          },
        });
      }
    },
  );

  it('SHA 不合法时不向 V1.9.13 提供可执行资产，只保留人工发布页', () => {
    const parsed = parseManifest(
      {
        version: '1.9.14',
        assets: {
          'win-x64': {
            name: 'Otto-Setup-1.9.14-win-x64.exe',
            url: `${OFFICIAL_UPDATE_MIRROR_ORIGIN}/downloads/Otto-Setup-1.9.14-win-x64.exe`,
            size: 913_914,
            sha256: 'not-a-sha256',
          },
        },
      },
      resolveManifestAssetOrigins(LEGACY_GITHUB_MANIFEST_URL),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      resolveCheckOutcome(
        parsed.manifest,
        '1.9.13',
        platformAssetKey('win32', 'x64'),
        RELEASE_PAGE_URL,
      ),
    ).toMatchObject({
      status: 'update-available',
      version: '1.9.14',
      asset: null,
      releasePageUrl: RELEASE_PAGE_URL,
    });
  });

  it('不会让 GitHub 清单借官方镜像授权任意第三方资产', () => {
    const parsed = parseManifest(
      {
        version: '1.9.14',
        assets: {
          'win-x64': {
            name: 'Otto-Setup-1.9.14-win-x64.exe',
            url: 'https://updates.example.com/Otto-Setup-1.9.14-win-x64.exe',
            size: 128,
            sha256: 'b'.repeat(64),
          },
        },
      },
      resolveManifestAssetOrigins(GITHUB_MANIFEST_URL),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.assets).toEqual({});
  });

  it('允许把显式 HTTPS 企业镜像放在 GitHub 前面，并自动去重', () => {
    expect(resolveManifestUrls('https://updates.example.com/otto/latest.json')).toEqual([
      'https://updates.example.com/otto/latest.json',
      PRIMARY_MANIFEST_URL,
      GITHUB_MANIFEST_URL,
      LEGACY_GITHUB_MANIFEST_URL,
    ]);
    expect(resolveManifestUrls(PRIMARY_MANIFEST_URL)).toEqual([
      PRIMARY_MANIFEST_URL,
      GITHUB_MANIFEST_URL,
      LEGACY_GITHUB_MANIFEST_URL,
    ]);
  });

  it.each([
    'http://updates.example.com/latest.json',
    'file:///tmp/latest.json',
    'https://user:password@updates.example.com/latest.json',
    'not-a-url',
  ])('忽略不安全或非法的镜像地址：%s', (candidate) => {
    expect(resolveManifestUrls(candidate)).toEqual([
      PRIMARY_MANIFEST_URL,
      GITHUB_MANIFEST_URL,
      LEGACY_GITHUB_MANIFEST_URL,
    ]);
  });
});
