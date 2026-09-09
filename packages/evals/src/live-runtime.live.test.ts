/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  liveEvalPreflight,
  LiveEvalBudget,
  LIVE_EVAL_EXECUTION_LIMITS as limits,
} from './liveEvalGate.js';

it.skipIf(process.env.OTTO_LIVE_EVAL !== '1')(
  'runs real-model tasks through Otto runtime (explicit opt-in, synthetic data only)',
  async () => {
    const admission = liveEvalPreflight(process.env);
    if (!admission.ready || !admission.identity)
      throw new Error(
        `Live evaluation refused before provider access: ${JSON.stringify(admission)}`,
      );
    const budget = new LiveEvalBudget(
      admission.identity.maxCostUsd,
      admission.identity.reserveUsd,
    );
    // Reject missing authorization/budget before initializing the entire Agent
    // runtime. Static imports paid that cost even for deliberately refused runs.
    const [
      { executeLiveCase, LIVE_CASES },
      {
        FEEDBACK_BASELINE,
        baselineFingerprint,
        summarizeBaseline,
        compareBaselines,
      },
    ] = await Promise.all([
      import('./liveRuntimeEval.js'),
      import('./feedbackBaseline.js'),
    ]);
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
      process.env.OTTO_EVAL_INPUT_PER_MILLION?.trim() &&
      process.env.OTTO_EVAL_OUTPUT_PER_MILLION?.trim() &&
      Number.isFinite(inputRate) &&
      inputRate >= 0 &&
      Number.isFinite(outputRate) &&
      outputRate >= 0
        ? { inputPerMillion: inputRate, outputPerMillion: outputRate }
        : undefined;
    const dataset = process.env.OTTO_EVAL_DATASET ?? 'office-v1';
    if (!['office-v1', 'feedback-v1'].includes(dataset))
      throw new Error('Unknown evaluation dataset');
    const cases = dataset === 'feedback-v1' ? FEEDBACK_BASELINE : LIVE_CASES;
    const count = Number(process.env.OTTO_EVAL_CASES ?? '1');
    const repeats = Number(process.env.OTTO_EVAL_REPEATS ?? '1');
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > cases.length ||
      !Number.isSafeInteger(repeats) ||
      repeats < 1 ||
      repeats > limits.maxRepeats ||
      count * repeats > limits.maxBatchRuns
    )
      throw new Error(
        'Use an available case count, 1–3 repeats, and at most 24 runs',
      );
    const workspace = fileURLToPath(new URL('../../../', import.meta.url));
    // Capture ALL dirty/untracked source before any model call. Legacy codeHash
    // below is diagnostic only; it is not the identity of this experiment.
    const sourceSnapshot = path.join(
      await mkdtemp(path.join(tmpdir(), 'otto-live-source-')),
      'snapshot',
    );
    execFileSync(
      process.execPath,
      ['scripts/agent-eval-baseline.mjs', 'freeze', sourceSnapshot],
      {
        cwd: workspace,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      },
    );
    const sourceManifest = JSON.parse(
      await readFile(path.join(sourceSnapshot, 'manifest.json'), 'utf8'),
    );
    // Before/after runtime variants must use the SAME grader and fixture tools.
    // A changed harness or pricing basis is not evidence of a runtime improvement.
    const harnessHash = createHash('sha256');
    for (const file of [
      'packages/evals/src/liveRuntimeEval.ts',
      'packages/evals/src/feedbackBaseline.ts',
      'packages/evals/src/liveEvalGate.ts',
      'packages/evals/src/live-runtime.live.test.ts',
    ]) {
      harnessHash
        .update(file)
        .update(await readFile(path.join(workspace, file)));
    }
    const harnessFingerprint = harnessHash.digest('hex');
    const codeFiles = [
      'package-lock.json',
      'packages/core/src/core/ottoChat.ts',
      'packages/server/src/runtime.ts',
      'packages/server/src/agentTurnTracker.ts',
      'packages/server/src/taskContract.ts',
      'packages/server/src/taskRequirements.ts',
      'packages/server/src/deliveryClosure.ts',
      'packages/server/src/deliveryRepair.ts',
      'packages/server/src/incompleteDelivery.ts',
      'packages/server/src/turnDirectiveLedger.ts',
      'packages/server/src/testCaseEvidence.ts',
      'packages/server/src/verificationEvidence.ts',
      'packages/server/src/turnControlPolicy.ts',
      'packages/server/src/taskGraph.ts',
      'packages/server/src/complexityRouter.ts',
      'packages/evals/src/liveRuntimeEval.ts',
    ];
    const identity = {
      datasetHash: baselineFingerprint(cases),
      model: modelId,
      provider: 'openai',
      modelConfiguration: createHash('sha256')
        .update(
          JSON.stringify({
            baseUrl,
            modelId,
            maxOutputTokens: limits.maxOutputTokens,
            timeout: limits.requestTimeoutMs,
            executionLimits: limits,
            runtime: process.version,
            platform: process.platform,
            architecture: process.arch,
            harnessFingerprint,
            rates: rates ?? null,
            declaredModelRevision: admission.identity.modelRevision,
            maxCostUsd: admission.identity.maxCostUsd,
            caseReserveUsd: admission.identity.reserveUsd,
            environment: sourceManifest.environment,
          }),
        )
        .digest('hex'),
    };
    let previous: Parameters<typeof compareBaselines>[0] | undefined;
    if (process.env.OTTO_EVAL_COMPARE_TO) {
      const contents = await readFile(
        path.resolve(process.env.OTTO_EVAL_COMPARE_TO),
        'utf8',
      );
      if (contents.length > 1_000_000)
        throw new Error('Baseline report exceeds size limit');
      previous = JSON.parse(contents) as Parameters<typeof compareBaselines>[0];
      // Fail before paid requests if case sets, data or model configuration differ.
      compareBaselines(previous, {
        ...identity,
        records: Array.from({ length: repeats }, (_, index) =>
          cases
            .slice(0, count)
            .map((c) => ({ id: c.id, repeat: index + 1, passed: false })),
        ).flat(),
      });
    }
    const codeHash = createHash('sha256');
    for (const file of codeFiles)
      codeHash.update(file).update(await readFile(path.join(workspace, file)));
    let commit = 'unavailable';
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: workspace,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
    } catch {
      /* source hash still identifies the inspected runtime */
    }
    const records = [];
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const testCase of cases.slice(0, count)) {
        const reservation = budget.reserve();
        if (reservation === null) {
          records.push({
            id: testCase.id,
            repeat,
            passed: false,
            error: 'not_run_budget_or_unknown_usage',
            estimatedCost: null,
          });
          continue;
        }
        try {
          const result = await executeLiveCase(
            testCase,
            {
              displayName: 'Isolated live evaluation',
              provider: 'openai',
              baseUrl,
              apiKey,
              modelId,
              maxOutputTokens: limits.maxOutputTokens,
              timeout: limits.requestTimeoutMs,
            },
            rates,
          );
          budget.settle(reservation, result.estimatedCost);
          records.push({ repeat, ...result });
        } catch {
          // Failed/unknown requests remain in the denominator. Never serialize credentials
          // or provider exception bodies, and never interpret unavailable usage as free.
          records.push({
            id: testCase.id,
            repeat,
            passed: false,
            error: 'runtime_or_provider_failure',
            estimatedCost: null,
          });
          budget.settle(reservation, null);
        }
      }
    }
    const directory = path.join(workspace, 'packages/evals/artifacts/live');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `live-${Date.now()}.json`),
      JSON.stringify(
        {
          version: 3,
          kind: 'live_model_runtime',
          scope: 'data_smoke_not_stage7_end_to_end',
          sourceFingerprint: sourceManifest.source.fingerprint,
          sourceSnapshot,
          declaredModelRevision: admission.identity.modelRevision,
          observedProviderRevision: null,
          budget: budget.snapshot(),
          generatedAt: new Date().toISOString(),
          dataset,
          ...identity,
          codeHash: codeHash.digest('hex'),
          commit,
          configuration: {
            ...limits,
            repeats,
            count,
            runtime: process.version,
            platform: process.platform,
          },
          records,
          summary: summarizeBaseline(records),
          comparison: previous
            ? compareBaselines(previous, { ...identity, records })
            : null,
          limitations: [
            'Reconstructed/synthetic inputs, not production data. Feedback cases replay reported requirements, not complete Electron UI or production backend flows.',
            'Costs are estimates; missing usage/prices remain null.',
            'Each case is capped at 10 model rounds and 150 seconds; use a provider-side billing cap.',
            'firstVisibleTextMs measures user-visible prose, not model TTFT; gated delivery may increase it. unverifiedTextChunks measures exposure before native acceptance, not whether a sentence claims success.',
            'Comparison deltas are paired per-task means (after minus before); missing measurements remain null. Fixed model aliases can still change at the provider; prefer a pinned model version.',
          ],
        },
        null,
        2,
      ),
    );
    expect(records.every((record) => record.passed)).toBe(true);
  },
  3_900_000,
);
