/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_FIXTURES, runCodeOracle, seedCodeProject } from './codeRepair.js';
import { EvidenceJournal, confinedFile } from './evidence.js';
import { executeRuntimeTask, assistantText } from './runtimeTask.js';
import { scriptedProvider } from './loopbackProvider.js';
const grader = fileURLToPath(
  new URL('../../../../scripts/real-task-code-oracle.cjs', import.meta.url),
);
const fixed = {
  'login-retry':
    'module.exports.login = async function login(send, refresh) { const first=await send("current"); if(first.status!==401)return first;return send(await refresh()); };\n',
  'utc-display':
    'module.exports.parseTimestamp = function parseTimestamp(value) { if(typeof value!=="string"||!value.trim())return null;const s=value.trim().replace(" ","T");const n=Date.parse(/(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(s)?s:s+"Z");return Number.isFinite(n)?n:null; };\n',
};
it('grades actual rich-message text, not an array coerced to [object Object]', () => {
  expect(
    assistantText([
      {
        role: 'assistant',
        content: [{ type: 'text', value: 'C:\\private\\output.pptx' }],
      },
    ]),
  ).toBe('C:\\private\\output.pptx');
});
it.each(['login-retry', 'utc-display'] as const)(
  'hidden oracle rejects the actual broken %s file, accepts a real edit',
  async (id) => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-real-code-'));
    await seedCodeProject(root, id);
    expect((await runCodeOracle(root, id, grader, true)).passed).toBe(false);
    await writeFile(path.join(root, CODE_FIXTURES[id].file), fixed[id]);
    expect((await runCodeOracle(root, id, grader, true)).passed).toBe(true);
  },
);
it('keeps evidence outside allowed paths and fails closed on missing observations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'otto-real-evidence-'));
  await expect(confinedFile(root, '../hidden.cjs', false)).rejects.toThrow();
  const journal = new EvidenceJournal(path.join(root, 'evidence'));
  const name = await journal.add('clicks.json', { count: 1 });
  await expect(journal.add('clicks.json', {})).rejects.toThrow();
  const result = await journal.finish(
    'ppt-preview',
    [{ check: 'preview-click', passed: true, evidence: [name] }],
    { mode: 'scripted' },
  );
  expect(result.independentPass).toBeNull();
  expect(result.traceComplete).toBe(false);
  await expect(journal.add('late.json', {})).rejects.toThrow();
});
it.each(['login-retry', 'utc-display'] as const)(
  'real product runtime uses native filesystem tools to repair %s (scripted provider, NOT a model score)',
  async (id) => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-real-runtime-'));
    const runDirectory = path.join(root, 'run');
    const file = path.join(runDirectory, 'workspace', CODE_FIXTURES[id].file);
    const provider = await scriptedProvider((round) => {
      if (round === 1)
        return { name: 'read_file', args: { absolute_path: file } };
      if (round === 2)
        return {
          name: 'write_file',
          args: { file_path: file, content: fixed[id] },
        };
      if (round === 3) return { name: 'eval_validate', args: {} };
      return '已修改文件，公开测试已运行；是否合格以独立验收结果为准。';
    });
    try {
      const { result } = await executeRuntimeTask({
        caseId: id,
        runDirectory,
        model: provider.model,
        mode: 'scripted',
        experimentHash: 'a'.repeat(64),
        sourceFingerprint: 'b'.repeat(64),
        oraclePath: grader,
        maxCaseMs: 30000,
      });
      expect(result.independentPass, JSON.stringify(result.checks)).toBe(true);
      expect(result.mode).toBe('scripted');
      expect(await readFile(file, 'utf8')).toContain(
        id === 'login-retry' ? 'await refresh()' : 'value.trim()',
      );
      const tools = JSON.parse(
        await readFile(
          path.join(runDirectory, 'evidence/native-tools.json'),
          'utf8',
        ),
      );
      expect(tools).toContainEqual({
        name: 'write_file',
        implementation: 'WriteFileTool',
      });
      expect(provider.calls()).toBeGreaterThan(2);
    } finally {
      await provider.close();
    }
  },
  60000,
);
