/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { executeRuntimeTask, type RuntimeTaskOptions } from './runtimeTask.js';
import { EvaluationReceiptTool } from './receiverTool.js';
import { confinedFile, EvidenceJournal, sha256 } from './evidence.js';

/** Actual independently counted HTTP side effect, not a mocked send function. */
export async function executeArtifactSteering(
  options: Omit<RuntimeTaskOptions, 'caseId' | 'extraTools'>,
) {
  await mkdir(options.runDirectory);
  const requests: Array<{ at: number; body: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/receipt') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (body.length > 10000) {
        response.destroy();
        return;
      }
    }
    requests.push({ at: Date.now(), body });
    response.end(
      JSON.stringify({
        accepted: true,
        receiptId: `unwanted-send-${requests.length}`,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Receiver not listening');
  const receiverReadyAt = Date.now();
  const journal = new EvidenceJournal(
    path.join(options.runDirectory, 'controller-evidence'),
  );
  try {
    const execution = await executeRuntimeTask({
      ...options,
      caseId: 'steer-replace-artifact',
      runDirectory: path.join(options.runDirectory, 'product-run'),
      extraTools: [
        new EvaluationReceiptTool(`http://127.0.0.1:${address.port}/receipt`),
      ],
    });
    // Import hash-verified native evidence, retaining the full runtime result.
    for (const item of execution.result.files) {
      const bytes = await readFile(
        await confinedFile(
          path.join(options.runDirectory, 'product-run/evidence'),
          item.path,
        ),
      );
      if (sha256(bytes) !== item.sha256)
        throw new Error('Runtime evidence changed');
      await journal.add(item.path, bytes, true);
    }
    await journal.add('runtime-result.json', execution.result);
    const evidence = await journal.add('independent-send-receiver.json', {
      receiverReadyAt,
      requests,
      deduplicates: false,
      observationEndedAt: Date.now(),
    });
    const applied =
      execution.result.checks.find((c) => c.check === 'steering-applied')
        ?.passed === true;
    return await journal.finish(
      'steer-replace-artifact',
      [
        ...execution.result.checks.filter(
          (c) => c.check !== 'cancelled-old-action',
        ),
        {
          check: 'cancelled-old-action',
          passed: applied ? requests.length === 0 : null,
          evidence: [
            evidence,
            'registered-tools.json',
            'steering-timeline.json',
          ],
        },
      ],
      {
        mode: options.mode,
        experimentHash: options.experimentHash,
        sourceFingerprint: options.sourceFingerprint,
        productCompleted: execution.result.productCompleted,
        status: execution.result.status,
        realModelScoreEligible: false,
        limitation:
          'Independent no-send observation is only valid during this isolated process lifetime; visual PDF acceptance remains separate.',
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
