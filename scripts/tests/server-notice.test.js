/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  copyEnterpriseServerNotice,
  readServerNotice,
  verifyServerNoticeContent,
} from '../server-notice.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const reviewedNotice = readServerNotice(repoRoot);

function fixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'otto-server-notice-'));
  mkdirSync(path.join(root, 'packages/server'), { recursive: true });
  mkdirSync(path.join(root, 'release'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('server third-party notice release contract', () => {
  it('includes native sharp/libvips and the elected MPL combination, without claiming a native rebuild', () => {
    const text = reviewedNotice.toString();
    for (const required of ['sharp 0.35.4', 'libvips 8.18.6',
      'LGPL-3.0-or-later', 'Mozilla Public License Version 2.0',
      'sharp-libvips-corresponding-source-audit-20260909.md',
      'BEGIN SHARP LIBVIPS-LICENSE', 'BEGIN SHARP THIRD-PARTY-NOTICES',
      'BEGIN SHARP SHARP-LICENSE', 'BEGIN SHARP MOZILLA-MPL-2.0',
    ]) expect(text.includes(required), required).toBe(true);
  });
  it('rejects interior edits or omission of every complete native license/notice block', () => fixture(root => {
    for (const title of ['SHARP-LICENSE', 'LIBVIPS-LICENSE', 'THIRD-PARTY-NOTICES', 'MOZILLA-MPL-2.0']) {
      const marker = `----- BEGIN SHARP ${title} -----\n`;
      const original = reviewedNotice.toString().replaceAll('\r\n', '\n');
      const offset = original.indexOf(marker) + marker.length;
      expect(offset).toBeGreaterThan(marker.length);
      writeFileSync(path.join(root, 'packages/server/NOTICE'), original.slice(0, offset + 100) + 'substitution' + original.slice(offset + 101));
      expect(() => readServerNotice(root)).toThrow(/license|notice/i);
    }
  }));
  it('includes complete LGPL/GPL and HEIC provenance without inventing the missing ISC grant', () => {
    const text = reviewedNotice.toString();
    for (const required of [
      'heic-decode 2.1.0',
      'libheif-js 1.23.2',
      'libde265 1.0.15',
      'GNU LESSER GENERAL PUBLIC LICENSE',
      'GNU GENERAL PUBLIC LICENSE',
      'Corresponding Application Code',
      'ISC declaration',
      'corresponding-source.tar.gz',
    ])
      expect(text).toContain(required);
  });

  it('rejects even an interior one-word change to the full reviewed HEIC license text', () =>
    fixture((root) => {
      writeFileSync(
        path.join(root, 'packages/server/NOTICE'),
        reviewedNotice
          .toString()
          .replace(
            'Corresponding Application Code',
            'Changed Application Code',
          ),
      );
      expect(() => readServerNotice(root)).toThrow(/license|notice/i);
    }));

  it('copies the complete reviewed NOTICE into the enterprise release byte-for-byte', () =>
    fixture((root) => {
      writeFileSync(path.join(root, 'packages/server/NOTICE'), reviewedNotice);
      copyEnterpriseServerNotice(root, path.join(root, 'release'));
      expect(readFileSync(path.join(root, 'release/NOTICE'))).toEqual(
        reviewedNotice,
      );
    }));

  it('fails closed if the source NOTICE is missing', () =>
    fixture((root) => {
      expect(() =>
        copyEnterpriseServerNotice(root, path.join(root, 'release')),
      ).toThrow(/NOTICE/);
    }));

  it('fails closed if the source notice is truncated', () =>
    fixture((root) => {
      writeFileSync(path.join(root, 'packages/server/NOTICE'), 'MIT License');
      expect(() =>
        copyEnterpriseServerNotice(root, path.join(root, 'release')),
      ).toThrow('missing required third-party notice content');
    }));

  it('rejects changed delivered notice text', () => {
    expect(() =>
      verifyServerNoticeContent(Buffer.from('substituted'), reviewedNotice),
    ).toThrow('differs from the reviewed source');
  });

  it('binds the NOTICE and its copying helper into provenance before hashing the release', () => {
    const build = readFileSync(
      path.join(repoRoot, 'scripts/build-enterprise-oneclick.mjs'),
      'utf8',
    );
    for (const input of [
      'packages/server/NOTICE',
      'scripts/server-notice.mjs',
    ]) {
      expect(
        build.match(new RegExp(`'${input.replaceAll('.', '\\.')}';?`, 'g')),
      ).toHaveLength(2);
    }
    const copy = build.indexOf(
      'copyEnterpriseServerNotice(repoRoot, releaseRoot);',
    );
    expect(copy).toBeGreaterThan(-1);
    expect(
      build.indexOf('const releaseFiles = filesBelow(releaseRoot);'),
    ).toBeGreaterThan(copy);
  });
});
