#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const USER_AGENT = 'Otto-release-anonymous-availability-gate/1.0';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const RETRYABLE_HTTP = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

function fail(message) {
  throw new Error(message);
}

function assertRepository(repository) {
  if (!REPOSITORY_PATTERN.test(repository)) {
    fail(`invalid GitHub repository identity: ${repository}`);
  }
}

function isAllowedAssetHost(hostname) {
  return (
    hostname === 'github.com' ||
    hostname === 'release-assets.githubusercontent.com' ||
    hostname === 'objects.githubusercontent.com' ||
    /^github-production-release-asset-[0-9a-f]+\.s3\.amazonaws\.com$/.test(
      hostname,
    )
  );
}

function assertAnonymousUrl(url, { api = false } = {}) {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail(`anonymous release URL is unsafe: ${url}`);
  }
  const allowed = api
    ? url.hostname === 'api.github.com'
    : isAllowedAssetHost(url.hostname);
  if (!allowed) {
    fail(`anonymous release redirect left the GitHub asset boundary: ${url}`);
  }
}

async function fetchAnonymous(url, { api = false, redirects = 3 } = {}) {
  let current = new URL(url);
  for (let attempt = 0; attempt <= redirects; attempt += 1) {
    assertAnonymousUrl(current, { api: api && attempt === 0 });
    let response;
    for (let requestAttempt = 1; requestAttempt <= 6; requestAttempt += 1) {
      try {
        response = await fetch(current, {
          redirect: 'manual',
          credentials: 'omit',
          headers: {
            Accept: api
              ? 'application/vnd.github+json'
              : 'application/octet-stream',
            'User-Agent': USER_AGENT,
            'X-GitHub-Api-Version': '2026-03-10',
          },
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
      } catch (error) {
        if (requestAttempt === 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      if (!RETRYABLE_HTTP.has(response.status) || requestAttempt === 6) {
        break;
      }
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    if (!response)
      fail(`anonymous GitHub request returned no response: ${current}`);
    if (REDIRECT_STATUSES.has(response.status)) {
      if (attempt === redirects) {
        fail(
          `anonymous release download exceeded ${redirects} redirects: ${url}`,
        );
      }
      const location = response.headers.get('location');
      if (!location) fail(`GitHub redirect omitted Location: ${current}`);
      await response.body?.cancel();
      current = new URL(location, current);
      assertAnonymousUrl(current);
      continue;
    }
    if (!response.ok) {
      fail(`anonymous GitHub request failed: ${response.status} ${current}`);
    }
    return response;
  }
  fail(`anonymous GitHub request did not converge: ${url}`);
}

async function requirePublicRepository(repository) {
  assertRepository(repository);
  const response = await fetchAnonymous(
    `https://api.github.com/repos/${repository}`,
    { api: true, redirects: 0 },
  );
  const metadata = await response.json();
  if (
    metadata?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    metadata.private !== false ||
    metadata.visibility !== 'public'
  ) {
    fail(`GitHub repository is not anonymously public: ${repository}`);
  }
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyRemoteFile(url, localFile) {
  const expectedSize = statSync(localFile).size;
  const expectedSha256 = await sha256File(localFile);
  const response = await fetchAnonymous(url);
  const hash = createHash('sha256');
  let actualSize = 0;
  if (!response.body) fail(`anonymous release response has no body: ${url}`);
  for await (const chunk of response.body) {
    actualSize += chunk.byteLength;
    hash.update(chunk);
  }
  const actualSha256 = hash.digest('hex');
  if (actualSize !== expectedSize || actualSha256 !== expectedSha256) {
    fail(
      `anonymous release asset mismatch: ${url} ` +
        `expected=${expectedSize}/${expectedSha256} ` +
        `actual=${actualSize}/${actualSha256}`,
    );
  }
}

async function verifyRelease(
  manifestRepository,
  assetRepository,
  tag,
  assetDir,
) {
  assertRepository(manifestRepository);
  assertRepository(assetRepository);
  if (!TAG_PATTERN.test(tag)) fail(`invalid release tag: ${tag}`);
  await requirePublicRepository(manifestRepository);
  if (assetRepository !== manifestRepository) {
    await requirePublicRepository(assetRepository);
  }

  const manifestPath = path.resolve(assetDir, 'latest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (`v${manifest.version}` !== tag || !manifest.assets) {
    fail('local update manifest identity is invalid');
  }
  const expectedPlatforms = ['mac-arm64', 'mac-x64', 'win-x64'];
  if (
    Object.keys(manifest.assets).sort().join('\n') !==
    expectedPlatforms.slice().sort().join('\n')
  ) {
    fail('local update manifest platform set is not exact');
  }

  const releaseBase = `https://github.com/${assetRepository}/releases/download/${tag}`;
  const assetNames = [];
  for (const platform of expectedPlatforms) {
    const asset = manifest.assets[platform];
    if (
      !asset ||
      typeof asset.name !== 'string' ||
      asset.url !== `${releaseBase}/${asset.name}`
    ) {
      fail(
        `manifest ${platform} does not use the anonymous canonical asset URL`,
      );
    }
    assetNames.push(asset.name, `${asset.name}.blockmap`);
  }
  if (new Set(assetNames).size !== 6) {
    fail('update manifest did not resolve to six exact desktop assets');
  }

  await verifyRemoteFile(
    `https://github.com/${manifestRepository}/releases/download/${tag}/latest.json`,
    manifestPath,
  );
  for (const name of assetNames) {
    await verifyRemoteFile(
      `${releaseBase}/${name}`,
      path.resolve(assetDir, name),
    );
  }
}

const args = process.argv.slice(2);
if (args[0] === '--repo-public' && args.length === 2) {
  await requirePublicRepository(args[1]);
} else if (args.length === 4) {
  await verifyRelease(args[0], args[1], args[2], args[3]);
} else {
  fail(
    'usage: verify-anonymous-github-release-assets.mjs --repo-public OWNER/REPO\n' +
      '   or: verify-anonymous-github-release-assets.mjs MANIFEST_REPO ASSET_REPO TAG ASSET_DIR',
  );
}
