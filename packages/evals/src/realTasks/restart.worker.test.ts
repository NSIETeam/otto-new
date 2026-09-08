/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { executeRuntimeTask, type RuntimeTaskOptions } from './runtimeTask.js';
import { EvaluationReceiptTool } from './receiverTool.js';
it('isolated process uses the actual runtime and durable recovery store', async () => {
  const requestFile = process.env.OTTO_REAL_TASK_WORKER;
  if (!requestFile)
    throw new Error('This worker must be launched by the real-task controller');
  const request = JSON.parse(
    await readFile(requestFile, 'utf8'),
  ) as RuntimeTaskOptions & { receiver: string };
  // This entry is infrastructure-only. A paid runner must pass the separate
  // experiment/budget admission path; do not accept keys in this JSON file.
  if (
    request.mode !== 'scripted' ||
    request.model.apiKey !== 'loopback-not-a-secret'
  )
    throw new Error('Worker only accepts the scripted infrastructure provider');
  let frames = 0;
  const result = await executeRuntimeTask({
    ...request,
    recovery: true,
    extraTools: [new EvaluationReceiptTool(request.receiver)],
    onFrame: (frame) => {
      if (frames++ < 500)
        appendFileSync(
          path.join(
            path.dirname(requestFile),
            request.resume
              ? 'resume-live-frames.jsonl'
              : 'first-live-frames.jsonl',
          ),
          JSON.stringify(frame) + '\n',
        );
    },
  });
  await writeFile(
    path.join(
      path.dirname(requestFile),
      request.resume ? 'resumed.json' : 'first.json',
    ),
    JSON.stringify(result.result),
    { flag: 'wx' },
  );
}, 90000);
