/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve(import.meta.dirname, '../../../.github/workflows/macos-preview.yml');

describe('macOS preview workflow contract', () => {
  it('publishes versionless, short-lived artifacts only from exact internal', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain('test "$GITHUB_SHA" = "$(git rev-parse origin/internal)"');
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
    expect(workflow).toContain('SHA256SUMS.txt');
    expect(workflow).toContain('sourceCommit:process.env.GITHUB_SHA');
  });

  it('builds the desktop entrypoint before electron-builder packages it', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const buildIndex = workflow.indexOf('name: Build desktop application');
    const signedPackageIndex = workflow.indexOf('name: Build signed macOS preview images');
    const unsignedPackageIndex = workflow.indexOf('name: Build unsigned macOS preview images');

    expect(buildIndex).toBeGreaterThan(-1);
    expect(workflow.slice(buildIndex, signedPackageIndex)).toContain('working-directory: packages/desktop');
    expect(workflow.slice(buildIndex, signedPackageIndex)).toContain('run: npm run build');
    expect(signedPackageIndex).toBeGreaterThan(buildIndex);
    expect(unsignedPackageIndex).toBeGreaterThan(buildIndex);
  });
});
