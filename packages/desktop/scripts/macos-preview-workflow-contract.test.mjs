/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve(
  import.meta.dirname,
  '../../../.github/workflows/macos-preview.yml',
);

const jobSection = (workflow, jobName, nextJobName) => {
  const start = workflow.indexOf(`  ${jobName}:`);
  const end = nextJobName
    ? workflow.indexOf(`  ${nextJobName}:`, start)
    : workflow.length;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
};

const expectExternalActionsPinned = (workflow) => {
  const actions = workflow
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*uses:\s+([^\s#]+)/)?.[1])
    .filter(Boolean)
    .filter((reference) => !reference.startsWith('./'));

  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) {
    expect(action).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
  }
};

describe('macOS preview workflow contract', () => {
  it('publishes versionless, short-lived artifacts only from exact internal', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain(
      'test "$GITHUB_SHA" = "$(git rev-parse origin/internal)"',
    );
    expect(workflow).toContain('Otto-macOS-Preview-${arch}.dmg');
    expect(workflow).toContain('Otto-macOS-Preview-Unsigned-${arch}.dmg');
    expect(workflow).toContain('name: Otto-macOS-Preview');
    expect(workflow).toContain('retention-days: 14');
    expect(workflow).toContain('TARGET_DMG_BYTES=$((120 * 1024 * 1024))');
    expect(workflow).toContain('MAX_DMG_BYTES=$((150 * 1024 * 1024))');
    expect(workflow).toContain('if [ "$size" -gt "$MAX_DMG_BYTES" ]');
    expect(workflow).toContain('if [ "$size" -gt "$TARGET_DMG_BYTES" ]');
    expect(workflow).toContain('hardCeilingBytes:Number(process.env.MAX_DMG_BYTES)');
    expect(workflow).not.toContain('softprops/action-gh-release');
    expect(workflow).not.toContain('gh release');
    expect(workflow).not.toContain('latest.json');
  });

  it('retains signed provenance and release-quality gates', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain('npm run doctor');
    expect(workflow).toContain('npm run test:ci');
    expect(workflow).toContain('MAC_CSC_LINK');
    expect(workflow).toContain('mode=unsigned-preview');
    expect(workflow).toContain('--config.mac.identity=null');
    expect(workflow).toContain('signingStatus:process.env.SIGNING_MODE');
    expect(workflow).toContain('hdiutil verify');
    expect(workflow).toContain('spctl --assess');
    expect(workflow).toContain('(cd preview-output && shasum -a 256 *.dmg > SHA256SUMS.txt)');
    expect(workflow).not.toContain('shasum -a 256 preview-output/*.dmg');
    expect(workflow).toContain('sourceCommit:process.env.GITHUB_SHA');
  });

  it('builds the desktop entrypoint before electron-builder packages it', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const buildIndex = workflow.indexOf('name: Build desktop application');
    const signedPackageIndex = workflow.indexOf(
      'name: Build signed macOS preview images',
    );
    const unsignedPackageIndex = workflow.indexOf(
      'name: Build unsigned macOS preview images',
    );

    expect(buildIndex).toBeGreaterThan(-1);
    expect(workflow.slice(buildIndex, signedPackageIndex)).toContain(
      'working-directory: packages/desktop',
    );
    expect(workflow.slice(buildIndex, signedPackageIndex)).toContain(
      'run: npm run build',
    );
    expect(signedPackageIndex).toBeGreaterThan(buildIndex);
    expect(unsignedPackageIndex).toBeGreaterThan(buildIndex);
  });

  it('validates exact internal source before invoking the privileged native workflow', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const validateSource = jobSection(
      workflow,
      'validate-source',
      'sqlcipher-native',
    );
    const sqlCipher = jobSection(workflow, 'sqlcipher-native', 'preview');

    expect(workflow.indexOf('  validate-source:')).toBeLessThan(
      workflow.indexOf('  sqlcipher-native:'),
    );
    expect(validateSource).toContain('permissions:\n      contents: read');
    expect(validateSource).not.toContain('id-token: write');
    expect(validateSource).not.toContain('attestations: write');
    expect(validateSource).toContain('git fetch --no-tags origin internal');
    expect(validateSource).toContain(
      'test "$GITHUB_SHA" = "$(git rev-parse origin/internal)"',
    );
    expect(sqlCipher).toContain('needs: validate-source');
    expect(sqlCipher).toContain('require_attestation: true');
  });

  it('keeps preview permissions read-only and pins every external action', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const topLevelPermissions = workflow.slice(
      workflow.indexOf('permissions:'),
      workflow.indexOf('concurrency:'),
    );
    const preview = jobSection(workflow, 'preview');

    expect(topLevelPermissions).toContain('contents: read');
    expect(topLevelPermissions).not.toContain('id-token: write');
    expect(topLevelPermissions).not.toContain('attestations: write');
    expect(preview).toContain(
      'permissions:\n      contents: read\n      attestations: read',
    );
    expect(preview).not.toContain('id-token: write');
    expect(preview).not.toContain('attestations: write');
    expect(preview).not.toContain('artifact-metadata: write');
    expectExternalActionsPinned(workflow);
  });
});
