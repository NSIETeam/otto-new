/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvidenceJournal,
  REAL_TASK_CHECKS,
  type RealTaskId,
} from './evidence.js';
import { executeRuntimeTask } from './runtimeTask.js';
import { executeRestartProbe } from './restart.js';
import { executeArtifactSteering } from './steering.js';
import {
  executeTenantBoundary,
  executeParkReplies,
  startEnterpriseFixture,
} from './enterprise.js';
import { createScriptedTaskProvider } from './scriptedPlans.js';

// Deliberately no business-success expect(). This process COLLECTS results;
// the independent report contains failures/unknowns even when collection exits 0.
it('collects real product executions, not a model-quality or release gate', async () => {
  const root = process.env.OTTO_REAL_TASK_OUTPUT;
  if (!root) throw new Error('Only launch through run-agent-real-tasks.mjs');
  const identity = JSON.parse(
    await readFile(path.join(root, 'identity.json'), 'utf8'),
  ) as {
    experimentHash: string;
    sourceFingerprint: string;
    cases: RealTaskId[];
  };
  const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const results: Array<Record<string, unknown>> = [];
  for (const caseId of identity.cases) {
    if (!Object.hasOwn(REAL_TASK_CHECKS, caseId))
      throw new Error('Unknown task');
    const caseRoot = path.join(root, caseId);
    const failureJournal = new EvidenceJournal(
      path.join(root, `${caseId}-controller`),
    );
    const started = Date.now();
    try {
      if (caseId === 'inbox-read-return' || caseId === 'project-delete') {
        const reason =
          'Fresh sealed desktop build + isolated authenticated/E2EE profile + owned-app launch and OS monitor are not provisioned. No substitute DOM/IPC mocks permitted.';
        const file = await failureJournal.add('preflight.json', { reason });
        results.push(
          await failureJournal.finish(caseId, [], {
            ...identity,
            cases: undefined,
            mode: 'scripted',
            status: 'not_run',
            reason,
            preflightEvidence: file,
          }),
        );
      } else if (caseId.startsWith('restart-')) {
        results.push(
          await executeRestartProbe({
            caseId: caseId as
              'restart-known-receipt' | 'restart-unknown-outcome',
            root: caseRoot,
            sourceRoot,
            ...identity,
          }),
        );
      } else if (caseId === 'tenant-boundary' || caseId === 'park-replies') {
        await mkdir(caseRoot);
        const fixture = await startEnterpriseFixture(
          path.join(caseRoot, 'database'),
        );
        const journal = new EvidenceJournal(path.join(caseRoot, 'evidence'));
        try {
          const observations =
            caseId === 'tenant-boundary'
              ? await executeTenantBoundary(fixture, journal)
              : (await executeParkReplies(fixture, journal)).observations;
          results.push(
            await journal.finish(caseId, observations, {
              ...identity,
              cases: undefined,
              mode: 'scripted',
              status: 'executed',
              durationMs: Date.now() - started,
              realModelScoreEligible: false,
              executionKind: 'actual-enterprise-api-not-a-model-task',
            }),
          );
        } finally {
          await fixture.close();
        }
      } else {
        const runDirectory = caseRoot;
        const workspace = path.join(
          runDirectory,
          caseId === 'steer-replace-artifact'
            ? 'product-run/workspace'
            : 'workspace',
        );
        const provider = await createScriptedTaskProvider(caseId, workspace);
        try {
          const options = {
            caseId,
            runDirectory,
            mode: 'scripted' as const,
            model: provider.model,
            ...identity,
          };
          const result =
            caseId === 'steer-replace-artifact'
              ? await executeArtifactSteering(options)
              : (await executeRuntimeTask(options)).result;
          results.push(result);
        } finally {
          await provider.close();
        }
      }
    } catch (error) {
      const detail = await failureJournal.add('execution-error.json', {
        error: String(error),
        at: Date.now(),
        durationMs: Date.now() - started,
      });
      results.push(
        await failureJournal.finish(caseId, [], {
          ...identity,
          cases: undefined,
          mode: 'scripted',
          status: 'execution_error',
          errorEvidence: detail,
          durationMs: Date.now() - started,
          realModelScoreEligible: false,
        }),
      );
    }
    await writeFile(
      path.join(root, `${caseId}.result.json`),
      JSON.stringify(results.at(-1), null, 2),
      { flag: 'wx' },
    );
  }
  await writeFile(
    path.join(root, 'matrix.json'),
    JSON.stringify(
      {
        mode: 'scripted',
        modelQualityScore: null,
        productionReleaseAllowed: false,
        results,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}, 900000);
