/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { constants, copyFileSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const heicLicenseSections = [
  {
    title: 'LIBHEIF-COPYING',
    sha256: 'fa81ce652315b013359d6e8e4744335f31a50c7c192907176d3632f78a3b4596',
  },
  {
    title: 'LIBDE265-COPYING',
    sha256: '02cc1585a20677992e0ba578fa692635dc193735f2691dc81de924b51c4e8020',
  },
  {
    title: 'EMSCRIPTEN-LICENSE',
    sha256: '06f2e6c024612605fc3c803b192983a26f19404eb54d78e399190d90ed32ac78',
  },
  {
    title: 'MUSL-COPYRIGHT',
    sha256: 'f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af',
  },
  {
    title: 'COMPILER-RT-LICENSE',
    sha256: '1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d',
  },
  {
    title: 'LIBCXX-LICENSE',
    sha256: '539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b',
  },
  {
    title: 'LIBCXXABI-LICENSE',
    sha256: 'e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c',
  },
];

export const SERVER_NOTICE_SOURCE = 'packages/server/NOTICE';
const sharpLicenseSections = [
  {
    "title": "SHARP-LICENSE",
    "sha256": "73ba74dfaa520b49a401b5d21459a8523a146f3b7518a833eea5efa85130bf68"
  },
  {
    "title": "LIBVIPS-LICENSE",
    "sha256": "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551"
  },
  {
    "title": "THIRD-PARTY-NOTICES",
    "sha256": "25ffcfa69e28b1913ced27ec778b90f24911a1bb3021253577e8b0af55db0d49"
  },
  {
    "title": "MOZILLA-MPL-2.0",
    "sha256": "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04"
  }
];
export const SERVER_NOTICE_ASAR_PATH = 'node_modules/otto-server/NOTICE';

export function readServerNotice(repoRoot) {
  const source = path.join(repoRoot, SERVER_NOTICE_SOURCE);
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('server NOTICE must be a regular file');
  }
  const contents = readFileSync(source);
  const text = contents.toString('utf8');
  for (const required of [
    '@wecom/aibot-node-sdk',
    'dingtalk-stream',
    'MIT License',
    'Permission is hereby granted, free of charge',
    'Copyright (c) 2023',
    'THE SOFTWARE IS PROVIDED "AS IS"',
    'SOFTWARE.',
    'heic-decode 2.1.0',
    'libheif-js 1.23.2',
    'libde265 1.0.15',
    'ISC declaration',
    'corresponding-source.tar.gz',
    'sharp 0.35.4',
    'libvips 8.18.6',
    'LGPL-3.0-or-later',
    'sharp-libvips-corresponding-source-audit-20260909.md',
  ]) {
    if (!text.includes(required)) {
      throw new Error(
        'server NOTICE is missing required third-party notice content',
      );
    }
  }
  const normalized = text.replaceAll('\r\n', '\n');
  for (const { title, sha256, family } of [
    ...heicLicenseSections.map(section => ({ ...section, family: 'HEIC' })),
    ...sharpLicenseSections.map(section => ({ ...section, family: 'SHARP' })),
  ]) {
    const begin = `----- BEGIN ${family} ${title} -----\n`;
    const end = `----- END ${family} ${title} -----`;
    const parts = normalized.split(begin);
    const endings = parts[1]?.split(end);
    if (
      parts.length !== 2 ||
      endings?.length !== 2 ||
      createHash('sha256').update(endings[0]).digest('hex') !== sha256
    ) {
      throw new Error(
        'server NOTICE is missing or changed a complete third-party license text',
      );
    }
  }
  return contents;
}

export function verifyServerNoticeContent(contents, expected) {
  // Git checkouts can use CRLF on Windows and LF on macOS/Linux; legal text
  // must remain identical, independent of that checkout-only difference.
  const normalize = (value) => value.toString('utf8').replaceAll('\r\n', '\n');
  if (normalize(contents) !== normalize(expected)) {
    throw new Error('packaged server NOTICE differs from the reviewed source');
  }
}

export function copyEnterpriseServerNotice(repoRoot, releaseRoot) {
  const contents = readServerNotice(repoRoot);
  const destination = path.join(releaseRoot, 'NOTICE');
  copyFileSync(
    path.join(repoRoot, SERVER_NOTICE_SOURCE),
    destination,
    constants.COPYFILE_EXCL,
  );
  verifyServerNoticeContent(readFileSync(destination), contents);
}
