/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { executeRestartProbe } from './restart.js';
import { executeRuntimeTask } from './runtimeTask.js';
import { scriptedProvider } from './loopbackProvider.js';
it('real native write + in-flight steering prevents the next backend write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'otto-real-steering-'));
  const runDirectory = path.join(root, 'run');
  const file = path.join(runDirectory, 'workspace/backend.cjs');
  const provider = await scriptedProvider((round) =>
    round < 3
      ? {
          name: 'write_file',
          args: {
            file_path: file,
            content:
              round === 1
                ? 'module.exports = { retained: true, first: true };\n'
                : 'module.exports = { retained: false, oldDirection: true };\n',
          },
        }
      : '已停止改动后端，保留第一次修改。',
  );
  try {
    const { result } = await executeRuntimeTask({
      caseId: 'steer-stop-backend',
      runDirectory,
      mode: 'scripted',
      model: provider.model,
      sourceFingerprint: 'b'.repeat(64),
      experimentHash: 'a'.repeat(64),
    });
    expect(result.independentPass, JSON.stringify(result.checks)).toBe(true);
    expect(await readFile(file, 'utf8')).not.toContain('oldDirection');
  } finally {
    await provider.close();
  }
}, 45000);
it.each(['restart-known-receipt', 'restart-unknown-outcome'] as const)(
  'kills/restarts actual product process at %s; real HTTP receiver must see exactly one send',
  async (caseId) => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-real-restart-'));
    const result = await executeRestartProbe({
      caseId,
      root: path.join(root, 'run'),
      sourceRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
      sourceFingerprint: 'b'.repeat(64),
      experimentHash: 'a'.repeat(64),
    });
    expect(result.independentPass, JSON.stringify(result.checks)).toBe(true);
  },
  120000,
);
