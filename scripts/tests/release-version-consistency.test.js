/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(path.resolve('package.json'), 'utf8'),
);
const version = packageJson.version;

const versionDisplays = [
  {
    path: 'packages/desktop/preview/live-bridge.ts',
    expected: [
      `Promise.resolve('${version}-browser')`,
      `currentVersion: '${version}'`,
    ],
  },
  {
    path: 'packages/desktop/src/renderer/browserPreviewBridge.ts',
    expected: [
      `Promise.resolve('${version}-browser-preview')`,
      `currentVersion: '${version}'`,
    ],
  },
  {
    path: 'packages/server/src/server.ts',
    expected: [
      `appVersion: () => Promise.resolve('${version}')`,
      `currentVersion: '${version}'`,
    ],
  },
  {
    path: 'packages/server/src/enterprise/bin.ts',
    expected: [`OTTO_APP_VERSION=${version}`],
  },
];

describe('release version displays', () => {
  it('bumps the integration ledger with packages without changing its trust or schema contract', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'otto-version-ledger-'));
    const files = [
      'scripts/version.js', 'package.json', 'package-lock.json',
      'packages/core/package.json', 'packages/desktop/package.json',
      'docs/server-integration-baseline.json',
      ...versionDisplays.map(({ path: sourcePath }) => sourcePath),
    ];
    try {
      for (const sourcePath of files) {
        const target = path.join(fixture, sourcePath);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.resolve(sourcePath), target);
      }
      const original = JSON.parse(readFileSync(path.join(fixture, 'docs/server-integration-baseline.json'), 'utf8'));
      execFileSync(process.execPath, ['scripts/version.js', 'patch'], { cwd: fixture });
      const updatedPackage = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8'));
      const updatedLedger = JSON.parse(readFileSync(path.join(fixture, 'docs/server-integration-baseline.json'), 'utf8'));
      expect(updatedPackage.version).not.toBe(version);
      expect(updatedLedger.release.clientVersion).toBe(updatedPackage.version);
      expect(updatedLedger.release.serverVersion).toBe(updatedPackage.version);
      expect(updatedLedger).toEqual({
        ...original,
        release: { ...original.release, clientVersion: updatedPackage.version, serverVersion: updatedPackage.version },
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(versionDisplays)(
    'keeps $path aligned with package.json',
    ({ path: sourcePath, expected }) => {
      const source = readFileSync(path.resolve(sourcePath), 'utf8');

      for (const literal of expected) {
        expect(source, `${sourcePath} is missing ${literal}`).toContain(
          literal,
        );
      }
    },
  );

  it('builds package references before release type checking', () => {
    const workflow = readFileSync(
      path.resolve('.github/workflows/release.yml'),
      'utf8',
    );
    const qualityGateStart = workflow.indexOf(
      '      - name: Release quality gates',
    );
    const focusedTestsStart = workflow.indexOf(
      '      - name: Focused regression tests',
      qualityGateStart,
    );
    const qualityGate = workflow.slice(qualityGateStart, focusedTestsStart);

    expect(qualityGateStart).toBeGreaterThanOrEqual(0);
    expect(focusedTestsStart).toBeGreaterThan(qualityGateStart);
    expect(qualityGate.indexOf('npm run build')).toBeGreaterThanOrEqual(0);
    expect(qualityGate.indexOf('npm run build')).toBeLessThan(
      qualityGate.indexOf('npm run typecheck'),
    );
    expect(workflow).toContain('      - name: Install dependencies\n        run: npm ci');
    expect(workflow).not.toContain(
      '      - name: Install dependencies\n        run: npm install',
    );

    const ciWorkflow = readFileSync(
      path.resolve('.github/workflows/ci.yml'),
      'utf8',
    );
    expect(ciWorkflow).toMatch(/Install dependencies\n\s+run: npm ci/);
    expect(ciWorkflow).not.toMatch(/Install dependencies\n\s+run: npm install/);
  });
});
