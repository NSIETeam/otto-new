#!/usr/bin/env node
/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
 * Offline admission only. No requests, installations, application launches or publication.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  buildRunSchedule,
  initialRunSlots,
  sourceChanges,
  assertPlanIdentity,
} from './agent-experiment-plan.mjs';
import {
  verifyBaseline,
  freezeBaseline,
  hashEntries,
  environmentInventory,
} from './agent-eval-baseline.mjs';
import {
  captureDependencies,
  deriveDependencyBaseline,
  newDirectory,
  seal,
  readSealed,
  verifyFiles,
} from './agent-experiment-files.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex');
const keys = [
  'node',
  'nodeExecutableSha256',
  'platform',
  'arch',
  'osRelease',
  'timeZone',
  'cpuModel',
  'logicalCpus',
  'ramBytes',
  'lockSha256',
  'installed',
  'missing',
];
export function environmentDifferences(before, after) {
  return keys.filter(
    (key) =>
      before[key] === undefined ||
      after[key] === undefined ||
      JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}
/** Reuse a completed private capture, never a mutable development node_modules. */
export function verifyDependencyCapture(directory, referenceEnvironment) {
  if (!path.isAbsolute(directory))
    throw new Error('Absolute dependency capture required');
  const manifest = readSealed(directory, 'manifest');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'private-dependency-byte-capture' ||
    hashEntries(manifest.files) !== manifest.fingerprint ||
    !verifyFiles(path.join(directory, 'payload'), manifest.files)
  )
    throw new Error('Private dependency bytes changed');
  if (
    environmentDifferences(manifest.environment, referenceEnvironment).length ||
    environmentDifferences(
      manifest.environment,
      environmentInventory(path.join(directory, 'payload')),
    ).length
  )
    throw new Error('Captured dependency environment changed');
  return manifest;
}
async function sourceModule(relative, base = root) {
  const output = await build({
    entryPoints: [path.join(base, relative)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
  );
}
export async function preparePair(
  before,
  after,
  destination,
  env = process.env,
  options = {},
) {
  const evaluatorWorktree = options.evaluatorWorktree ?? root;
  if (options.dependencies && options.capturedDependencies)
    throw new Error('Choose fresh or sealed dependencies, not both');
  for (const dir of [before, after, destination, evaluatorWorktree])
    if (!path.isAbsolute(dir)) throw new Error('Absolute paths required');
  if (existsSync(destination))
    throw new Error('Use a new output directory; never overwrite a campaign');
  for (const dir of [before, after]) {
    const relative = path.relative(dir, destination);
    if (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    )
      throw new Error('Output must be outside frozen snapshots');
    if (!verifyBaseline(dir).valid)
      throw new Error('Snapshot integrity failed');
  }
  const originalBefore = before,
    originalAfter = after;
  const originalBeforeManifest = readSealed(before, 'manifest');
  const originalAfterManifest = readSealed(after, 'manifest');
  newDirectory(destination, [
    before,
    after,
    root,
    evaluatorWorktree,
    ...(options.dependencies ? [options.dependencies] : []),
    ...(options.capturedDependencies ? [options.capturedDependencies] : []),
  ]);
  // Pin the complete current evaluator worktree too, including uncommitted tools,
  // input definitions, grader code and this runner. Do not compile mutable files later.
  const evaluator = freezeBaseline(
    evaluatorWorktree,
    path.join(destination, 'evaluator'),
  );
  const evaluatorRoot = path.join(destination, 'evaluator/source');
  let dependencies = null;
  let dependencyDirectory = null;
  if (options.dependencies || options.capturedDependencies) {
    if (options.dependencies && !path.isAbsolute(options.dependencies))
      throw new Error('Absolute dependency directory required');
    dependencyDirectory =
      options.capturedDependencies ?? path.join(destination, 'dependencies');
    dependencies = options.capturedDependencies
      ? verifyDependencyCapture(
          dependencyDirectory,
          originalAfterManifest.environment,
        )
      : captureDependencies(options.dependencies, after, dependencyDirectory);
    deriveDependencyBaseline(before, after, path.join(destination, 'before'));
    deriveDependencyBaseline(after, after, path.join(destination, 'after'));
    before = path.join(destination, 'before');
    after = path.join(destination, 'after');
  }
  const old = readSealed(before, 'manifest'),
    next = readSealed(after, 'manifest');
  const datasetPath = 'packages/evals/baselines/stage7-real-tasks-v1.json';
  const datasetBytes = readFileSync(path.join(evaluatorRoot, datasetPath)),
    dataset = JSON.parse(datasetBytes);
  const failureRegisterPath =
    'packages/evals/baselines/stage0-failure-register-v1.json';
  const failureRegisterBytes = readFileSync(
    path.join(evaluatorRoot, failureRegisterPath),
  );
  const { liveEvalPreflight, LIVE_EVAL_EXECUTION_LIMITS } = await sourceModule(
    'packages/evals/src/liveEvalGate.ts',
    evaluatorRoot,
  );
  const { compareStage7 } = await sourceModule(
    'packages/evals/src/stage7Comparison.ts',
    evaluatorRoot,
  );
  const preflight = liveEvalPreflight(env);
  const mismatch = environmentDifferences(old.environment, next.environment);
  const evaluatorFingerprint = evaluator.source.fingerprint;
  const identity = {
    model: preflight.declaration.ready ? preflight.declaration.identity : null,
    modelDeclaration: preflight.declaration,
    beforeEnvironment: old.environment,
    afterEnvironment: next.environment,
    evaluatorFingerprint,
    beforeSource: old.source.fingerprint,
    afterSource: next.source.fingerprint,
    dependencyFingerprint: dependencies?.fingerprint ?? null,
    datasetHash: sha(datasetBytes),
    failureRegisterHash: sha(failureRegisterBytes),
    grading: dataset.grading,
    executionLimits: LIVE_EVAL_EXECUTION_LIMITS,
    repeats: dataset.repeats,
    order: buildRunSchedule(dataset, LIVE_EVAL_EXECUTION_LIMITS.maxBatchRuns),
    comparisonScope:
      'complete_product_versions_not_runtime_only_causal_attribution',
    sourceChangesHash: sha(sourceChanges(old.source.files, next.source.files)),
    toolProfile: {
      smoke: {
        tools: ['read_file', 'write_file', 'run_shell_command'],
        source: 'packages/evals/src/liveRuntimeEval.ts',
        sourceHash:
          evaluator.source.files.find(
            (f) => f.path === 'packages/evals/src/liveRuntimeEval.ts',
          )?.sha256 ?? null,
        scope:
          'Isolated JSON paths and fixed acceptance command only; not the six-family task runner',
      },
      realTaskAdapters: dataset.cases.map((c) => ({
        id: c.id,
        status: c.adapter,
      })),
      // Actual tool implementation bytes are bound for each product, separately
      // from the external evaluator. Tool names alone are not a fixed toolset.
      nativeToolSources: Object.fromEntries(
        [
          ['before', old],
          ['after', next],
        ].map(([variant, manifest]) => [
          variant,
          hashEntries(
            manifest.source.files.filter(
              (f) =>
                f.path.startsWith('packages/core/src/tools/') ||
                f.path.startsWith('packages/core/src/policy/') ||
                f.path.startsWith('packages/core/src/config/'),
            ),
          ),
        ]),
      ),
      evaluatorAdapterSources: hashEntries(
        evaluator.source.files.filter((f) =>
          f.path.startsWith('packages/evals/src/realTasks/'),
        ),
      ),
      realModelExecutionAdmitted: false,
      status: 'real_task_tools_pending',
    },
  };
  const plan = {
    beforeSource: old.source.fingerprint,
    afterSource: next.source.fingerprint,
    experimentHash: sha(identity),
    cases: dataset.cases.map(({ id, family, critical }) => ({
      id,
      family,
      critical,
    })),
    repeats: dataset.repeats,
  };
  const blockers = [
    ...(!preflight.declaration.ready
      ? ['model_or_budget_declaration_incomplete']
      : []),
    ...(!preflight.ready
      ? ['execution_permission_or_credential_not_ready']
      : []),
    ...(mismatch.length ? ['environment_mismatch'] : []),
    ...(!dependencies ? ['private_dependency_capture_missing'] : []),
    // A dataset flag is not a sandbox attestation or an executable A/B adapter.
    'confined_real_model_pair_executor_not_provisioned',
    ...dataset.cases
      .filter((c) => c.adapter !== 'implemented')
      .map((c) => `adapter_unavailable:${c.id}`),
  ];
  const report = {
    schemaVersion: 3,
    kind: 'offline_stage7_preparation_not_model_results',
    beforeSnapshot: before,
    afterSnapshot: after,
    originalSnapshots: {
      before: {
        directory: originalBefore,
        sourceFingerprint: originalBeforeManifest.source.fingerprint,
      },
      after: {
        directory: originalAfter,
        sourceFingerprint: originalAfterManifest.source.fingerprint,
      },
    },
    dependencyCapture: dependencies
      ? {
          directory: dependencyDirectory,
          storage: options.capturedDependencies
            ? 'referenced_verified_capture'
            : 'private_copy',
          fingerprint: dependencies.fingerprint,
          bytes: dependencies.bytes,
          files: dependencies.files.length,
        }
      : null,
    derivations: {
      before: old.derivation ?? null,
      after: next.derivation ?? null,
    },
    plan,
    identity,
    sourceChanges: sourceChanges(old.source.files, next.source.files),
    preflight,
    environmentDifferences: mismatch,
    blockers,
    readyForLive: blockers.length === 0,
    comparison: compareStage7(plan, []),
    paidModelCalls: 0,
    productionReleaseAllowed: false,
  };
  if (!verifyBaseline(path.join(destination, 'evaluator')).valid)
    throw new Error('Evaluator capture changed');
  assertPlanIdentity(plan, identity);
  seal(destination, 'run-slots', {
    schemaVersion: 1,
    kind: 'preregistered_slots_not_execution_results',
    experimentHash: plan.experimentHash,
    runs: initialRunSlots(identity, plan.experimentHash),
    note: 'Keep this registration unchanged. Store every later attempt as a new raw result bound to its runId.',
  });
  seal(destination, 'preparation', report);
  return report;
}

/** Checks bytes and host conditions, not model quality. No execution is authorized. */
export function verifyPair(directory) {
  const report = readSealed(directory, 'preparation');
  if (
    ![2, 3].includes(report.schemaVersion) ||
    report.plan.experimentHash !== sha(report.identity)
  )
    throw new Error('Experiment identity changed');
  assertPlanIdentity(report.plan, report.identity);
  const evaluator = verifyBaseline(path.join(directory, 'evaluator'));
  if (
    !evaluator.valid ||
    evaluator.fingerprint !== report.identity.evaluatorFingerprint
  )
    throw new Error('Frozen evaluator changed');
  for (const variant of ['before', 'after']) {
    const checked = verifyBaseline(report[variant + 'Snapshot']);
    if (
      !checked.valid ||
      checked.fingerprint !== report.plan[variant + 'Source']
    )
      throw new Error('Frozen variant changed');
    const original = report.originalSnapshots[variant];
    if (
      verifyBaseline(original.directory).fingerprint !==
        original.sourceFingerprint ||
      !verifyBaseline(original.directory).valid
    )
      throw new Error('Original snapshot changed');
  }
  if (report.schemaVersion === 3) {
    const old = readSealed(report.beforeSnapshot, 'manifest');
    const next = readSealed(report.afterSnapshot, 'manifest');
    const changes = sourceChanges(old.source.files, next.source.files);
    if (
      sha(changes) !== report.identity.sourceChangesHash ||
      !isDeepStrictEqual(changes, report.sourceChanges)
    )
      throw new Error('Source change registration differs from frozen bytes');
    const datasetBytes = readFileSync(
      path.join(
        directory,
        'evaluator/source/packages/evals/baselines/stage7-real-tasks-v1.json',
      ),
    );
    const dataset = JSON.parse(datasetBytes);
    if (
      sha(datasetBytes) !== report.identity.datasetHash ||
      !isDeepStrictEqual(
        dataset.cases.map(({ id, family, critical }) => ({
          id,
          family,
          critical,
        })),
        report.plan.cases,
      )
    )
      throw new Error('Frozen task registration changed');
    if (
      sha(
        readFileSync(
          path.join(
            directory,
            'evaluator/source/packages/evals/baselines/stage0-failure-register-v1.json',
          ),
        ),
      ) !== report.identity.failureRegisterHash
    )
      throw new Error('Failure register changed');
    const slots = readSealed(directory, 'run-slots');
    if (
      slots.experimentHash !== report.plan.experimentHash ||
      !isDeepStrictEqual(
        slots.runs,
        initialRunSlots(report.identity, report.plan.experimentHash),
      )
    )
      throw new Error('Initial run slots changed or were mistaken for results');
    if (
      report.readyForLive ||
      !report.blockers.includes(
        'confined_real_model_pair_executor_not_provisioned',
      )
    )
      throw new Error(
        'Offline preparation cannot attest a real-model executor',
      );
  }
  if (report.dependencyCapture) {
    const dir =
      report.schemaVersion === 3
        ? report.dependencyCapture.directory
        : path.join(directory, 'dependencies');
    const manifest = readSealed(dir, 'manifest');
    if (
      hashEntries(manifest.files) !== report.identity.dependencyFingerprint ||
      !verifyFiles(path.join(dir, 'payload'), manifest.files)
    )
      throw new Error('Private dependency bytes changed');
    if (
      environmentDifferences(
        manifest.environment,
        environmentInventory(path.join(dir, 'payload')),
      ).length
    )
      throw new Error('Runtime or dependency environment changed');
  }
  return {
    valid: true,
    experimentHash: report.plan.experimentHash,
    readyForLive: report.readyForLive,
    blockers: report.blockers,
    originalSourcesUnchanged: true,
    productionReleaseAllowed: false,
  };
}

export async function assertPairReady(directory, env = process.env) {
  const verified = verifyPair(directory);
  const report = readSealed(directory, 'preparation');
  const { liveEvalPreflight } = await sourceModule(
    'packages/evals/src/liveEvalGate.ts',
    path.join(directory, 'evaluator/source'),
  );
  const current = liveEvalPreflight(env);
  if (
    !verified.readyForLive ||
    !current.ready ||
    sha(current.identity) !== sha(report.identity.model)
  )
    throw new Error(
      'Experiment not ready or model/budget changed; create a new experiment, never overwrite',
    );
  return verified;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [before, after, destination, flag, dependencies] =
      process.argv.slice(2);
    if (before === 'verify') {
      console.log(JSON.stringify(verifyPair(after), null, 2));
    } else {
      if (
        flag &&
        !['--common-dependencies', '--sealed-dependencies'].includes(flag)
      )
        throw new Error('Unknown option');
      if (flag && !dependencies)
        throw new Error('Dependency directory required');
      const report = await preparePair(
        before,
        after,
        destination,
        process.env,
        flag === '--sealed-dependencies'
          ? { capturedDependencies: dependencies }
          : { dependencies },
      );
      console.log(
        JSON.stringify(
          {
            directory: destination,
            readyForLive: report.readyForLive,
            blockers: report.blockers,
            environmentDifferences: report.environmentDifferences,
            experimentHash: report.plan.experimentHash,
            dependencyCapture: report.dependencyCapture,
            preflight: report.preflight,
            paidModelCalls: 0,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
