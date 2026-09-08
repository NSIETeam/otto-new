/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeRuntimeTask } from './runtimeTask.js';
import { scriptedProvider } from './loopbackProvider.js';
import { parseArtifact } from './artifacts.js';

it('independent parsing rejects damaged PPT/PDF files', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'otto-real-artifact-control-'),
  );
  for (const file of ['broken.pptx', 'broken.pdf']) {
    await writeFile(path.join(root, file), 'not a document');
    await expect(parseArtifact(root, file)).rejects.toThrow();
  }
});
it.each(['ppt-preview', 'dual-artifact'] as const)(
  'submits %s through the real document tool/guard; blocked dispatch or missing UI is never success',
  async (caseId) => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-real-documents-'));
    const runDirectory = path.join(root, 'run');
    const provider = await scriptedProvider((round) => {
      const format =
        caseId === 'dual-artifact'
          ? ['pptx', 'pdf', 'pptx', 'pdf'][round - 1]
          : round === 1
            ? 'pptx'
            : null;
      if (format)
        return {
          name: 'generate_document',
          args: {
            format: 'slides',
            output_format: format,
            output_path: path.join(runDirectory, `workspace/output.${format}`),
            title: 'Evaluation report',
            content: `# Overview\n\n- Isolated fixture\n\n---\n\n# ${round > 2 ? 'Progress revised' : 'Progress'}\n\n- Evidence collected\n\n---\n\n# Next Steps\n\n- Review results`,
          },
        };
      return '文件生成调用已经结束，请在 Otto 中查看产物；完整验收尚未完成。';
    });
    try {
      const { result } = await executeRuntimeTask({
        caseId,
        runDirectory,
        mode: 'scripted',
        model: provider.model,
        sourceFingerprint: 'b'.repeat(64),
        experimentHash: 'a'.repeat(64),
        maxCaseMs: 90000,
      });
      expect(result.independentPass).not.toBe(true);
      expect(result.traceComplete).toBe(false);
      expect(
        result.checks.find((c) => c.check === 'preview-screenshot')?.passed,
      ).toBeNull();
      expect(provider.calls()).toBeGreaterThan(1);
    } finally {
      await provider.close();
    }
  },
  110000,
);
