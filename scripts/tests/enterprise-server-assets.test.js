/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

const builder = readFileSync('scripts/build-enterprise-oneclick.mjs', 'utf8');
// Execute the actual builder's copy block, without signing/building/deploying.
const walk = builder.slice(
  builder.indexOf('function filesBelow('),
  builder.indexOf('\nconst enterpriseBuildWorkspaces'),
);
const copy = builder.slice(
  builder.indexOf('  const serverFiles = ['),
  builder.indexOf('\n  const coreDist ='),
);
const assets = [
  [
    'modules/policy_intelligence/policy-sources.json',
    'modules/policy_intelligence/policySources.ts',
  ],
  [
    'modules/park_services/enterpriseIndustryTaxonomy.json',
    'modules/park_services/enterpriseIndustry.ts',
  ],
];
const sandboxes = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0))
    rmSync(sandbox, { recursive: true, force: true });
});

function fixture() {
  const sandbox = mkdtempSync(
    path.join(os.tmpdir(), 'otto-enterprise-assets-'),
  );
  sandboxes.push(sandbox);
  const serverDist = path.join(sandbox, 'dist');
  const releaseRoot = path.join(sandbox, 'release');
  mkdirSync(releaseRoot);
  writeFileSync(path.join(releaseRoot, 'package.json'), '{"type":"module"}');
  for (const [relative, importer] of assets) {
    const target = path.join(serverDist, 'src', relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join('packages/server/src', relative), target);
    const source = readFileSync(
      path.join('packages/server/src', importer),
      'utf8',
    );
    const jsonImport = source.match(
      /^import (\w+) from '[^']+\.json' with \{ type: 'json' \};$/mu,
    );
    expect(jsonImport, importer).not.toBeNull();
    // The production import statement and real data, executed by native Node ESM.
    writeFileSync(
      path.join(serverDist, 'src', importer.replace(/\.ts$/u, '.js')),
      `${jsonImport[0]}\nexport default ${jsonImport[1]};\n`,
    );
  }
  function packageRuntime() {
    expect(walk).toContain('unsupported release entry');
    expect(copy).toContain('cpSync(source, target)');
    runInNewContext(
      `${walk}\n${copy}`,
      {
        path,
        serverDist,
        releaseRoot,
        readdirSync,
        existsSync,
        mkdirSync,
        cpSync,
      },
      { timeout: 5000 },
    );
  }
  return { serverDist, releaseRoot, packageRuntime };
}

describe('enterprise server runtime data packaging', () => {
  it('copies byte-identical policy and industry data and resolves both native ESM JSON imports offline', () => {
    const { releaseRoot, packageRuntime } = fixture();
    packageRuntime();
    for (const [relative] of assets) {
      expect(readFileSync(path.join(releaseRoot, 'src', relative))).toEqual(
        readFileSync(path.join('packages/server/src', relative)),
      );
    }
    const probe = path.join(releaseRoot, 'probe.mjs');
    writeFileSync(
      probe,
      assets
        .map(
          ([, importer], index) =>
            `import data${index} from './src/${importer.replace(/\.ts$/u, '.js')}';\nif (!Array.isArray(data${index}) || data${index}.length === 0) throw new Error('Empty runtime data');`,
        )
        .join('\n'),
    );
    const result = spawnSync(process.execPath, [probe], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(assets)(
    'fails packaging when required runtime resource %s is missing',
    (relative) => {
      const { serverDist, packageRuntime } = fixture();
      rmSync(path.join(serverDist, 'src', relative));
      expect(packageRuntime).toThrow('missing built server file:');
    },
  );

  it('does not broaden the data allowlist to fixture databases, arbitrary JSON, source maps or declarations', () => {
    const { serverDist, releaseRoot, packageRuntime } = fixture();
    const excluded = [
      'enterprise/fixtures/fixture-metadata.json',
      'enterprise/fixtures/data.db',
      'modules/private-config.json',
      'server.js.map',
      'server.d.ts',
      'server.ts',
    ];
    for (const relative of excluded) {
      const target = path.join(serverDist, 'src', relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'must not ship');
    }
    packageRuntime();
    for (const relative of excluded)
      expect(
        existsSync(path.join(releaseRoot, 'src', relative)),
        relative,
      ).toBe(false);
  });
});
