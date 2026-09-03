/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeLiveCase, LIVE_CASES } from './liveRuntimeEval.js';

it.skipIf(process.env.OTTO_LIVE_EVAL !== '1')(
  'runs real-model tasks through Otto runtime (explicit opt-in, synthetic data only)',
  async () => {
    const baseUrl = process.env.OTTO_EVAL_BASE_URL;
    const apiKey = process.env.OTTO_EVAL_API_KEY;
    const modelId = process.env.OTTO_EVAL_MODEL;
    if (!baseUrl || !apiKey || !modelId)
      throw new Error(
        'Set OTTO_EVAL_BASE_URL, OTTO_EVAL_API_KEY and OTTO_EVAL_MODEL explicitly; no existing user credentials are read.',
      );
    const endpoint = new URL(baseUrl);
    if (
      endpoint.username ||
      endpoint.password ||
      (endpoint.protocol !== 'https:' &&
        !(
          endpoint.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
        ))
    )
      throw new Error('Use HTTPS or a loopback local model endpoint');
    const inputRate = Number(process.env.OTTO_EVAL_INPUT_PER_MILLION);
    const outputRate = Number(process.env.OTTO_EVAL_OUTPUT_PER_MILLION);
    const rates =
      Number.isFinite(inputRate) &&
      inputRate >= 0 &&
      Number.isFinite(outputRate) &&
      outputRate >= 0
        ? { inputPerMillion: inputRate, outputPerMillion: outputRate }
        : undefined;
    const count = Number(process.env.OTTO_EVAL_CASES ?? '1');
    if (!Number.isSafeInteger(count) || count < 1 || count > LIVE_CASES.length)
      throw new Error('OTTO_EVAL_CASES must be 1–6');
    const records = [];
    for (const testCase of LIVE_CASES.slice(0, count)) {
      try {
        records.push(
          await executeLiveCase(
            testCase,
            {
              displayName: 'Isolated live evaluation',
              provider: 'openai',
              baseUrl,
              apiKey,
              modelId,
              maxOutputTokens: 2048,
              timeout: 45000,
            },
            rates,
          ),
        );
      } catch {
        // Failed/unknown requests remain in the denominator. Never serialize credentials
        // or provider exception bodies, and never interpret unavailable usage as free.
        records.push({
          id: testCase.id,
          passed: false,
          correct: false,
          completed: false,
          error: 'runtime_or_provider_failure',
          estimatedCost: null,
        });
      }
    }
    const directory = path.resolve('packages/evals/artifacts/live');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `live-${Date.now()}.json`),
      JSON.stringify(
        {
          version: 1,
          kind: 'live_model_runtime',
          generatedAt: new Date().toISOString(),
          dataset: 'otto-synthetic-office-v1',
          records,
          summary: {
            total: records.length,
            passed: records.filter((record) => record.passed).length,
          },
          limitations: [
            'Synthetic office fixtures; not a competitor ranking or representative production benchmark.',
            'Costs are estimates; missing usage/prices remain null.',
            'Each case is capped at 10 model rounds and 150 seconds; use a provider-side billing cap.',
          ],
        },
        null,
        2,
      ),
    );
    expect(records.every((record) => record.passed)).toBe(true);
  },
  1_000_000,
);
