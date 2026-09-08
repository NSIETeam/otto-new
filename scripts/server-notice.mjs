/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { constants, copyFileSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SERVER_NOTICE_SOURCE = 'packages/server/NOTICE';
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
  ]) {
    if (!text.includes(required)) {
      throw new Error(
        'server NOTICE is missing required third-party notice content',
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
