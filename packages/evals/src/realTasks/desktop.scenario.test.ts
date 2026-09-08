/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyDesktopBuild } from './desktop.js';
import { EvidenceJournal, sha256 } from './evidence.js';
import { requireRealModelConfinement } from './runtimeTask.js';

it('cannot enable arbitrary real-model reads merely by configuring a model key', () => {
  expect(requireRealModelConfinement).toThrow('native read isolation');
});

it('rejects missing/stale/mismatched desktop build before any GUI operation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'otto-desktop-preflight-'));
  const witness = {
    sourceFingerprint: 'a'.repeat(64),
    buildDirectory: root,
    entry: 'dist/main/index.js',
    files: [] as Array<{ path: string; sha256: string }>,
  };
  await expect(verifyDesktopBuild(witness, 'b'.repeat(64))).rejects.toThrow(
    'source',
  );
  await expect(verifyDesktopBuild(witness, 'a'.repeat(64))).rejects.toThrow(
    'Unsealed',
  );
  for (const name of [
    'dist/main/index.js',
    'dist/preload/index.js',
    'dist/renderer/index.html',
    'dist/renderer/app.js',
  ]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'fixture, never launched', {
      flag: 'wx',
    });
    witness.files.push({
      path: name,
      sha256: sha256('fixture, never launched'),
    });
  }
  await verifyDesktopBuild(witness, 'a'.repeat(64));
  await writeFile(path.join(root, 'dist/preload/index.js'), 'changed');
  await expect(verifyDesktopBuild(witness, 'a'.repeat(64))).rejects.toThrow(
    'Stale',
  );
});
it('rejects unrelated evidence and detects tampered evidence before sealing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'otto-evidence-negative-'));
  const journal = new EvidenceJournal(root);
  const file = await journal.add('actual.json', { result: false });
  await expect(
    journal.finish(
      'login-retry',
      [{ check: 'unrelated', passed: true, evidence: [file] }],
      {},
    ),
  ).rejects.toThrow('does not belong');
  await writeFile(path.join(root, file), 'tampered');
  await expect(journal.finish('login-retry', [], {})).rejects.toThrow(
    'changed',
  );
});
