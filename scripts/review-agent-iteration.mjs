#!/usr/bin/env node
/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
 * Offline evaluator controls only: never invokes a model, app or production API.
 */
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyBaseline } from './agent-eval-baseline.mjs';
import {
  assertNoLinks,
  fileDigest,
  newDirectory,
  readSealed,
  safeRelative,
  seal,
  sha,
} from './agent-experiment-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const families = [
  'code_repair',
  'file_delivery',
  'gui',
  'restart',
  'steering',
  'enterprise',
];
const digest = (value) =>
  typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const normalize = (value) =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
export function taskContentHash(task) {
  return sha(
    JSON.stringify({
      family: task.family,
      request: normalize(task.request),
      oracle: task.oracle.map(normalize).sort(),
      critical: task.critical === true,
    }),
  );
}
function readJson(file) {
  assertNoLinks(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > 16 * 1024 * 1024)
    throw new Error('Unsafe/oversized input');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function outside(directory, excluded) {
  const rel = path.relative(path.resolve(excluded), path.resolve(directory));
  return (
    rel &&
    (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
  );
}
export function reserveHoldout(inputFile, candidateSnapshot, destination) {
  for (const p of [inputFile, candidateSnapshot, destination])
    if (!path.isAbsolute(p)) throw new Error('Absolute paths required');
  if (
    !outside(inputFile, root) ||
    !outside(destination, root) ||
    !outside(inputFile, candidateSnapshot)
  )
    throw new Error(
      'Holdout tasks must stay outside product/evaluator source and candidate snapshot',
    );
  const { tasks } = readJson(inputFile);
  if (
    !Array.isArray(tasks) ||
    tasks.length !== 12 ||
    tasks.some(
      (t) =>
        !/^[a-z\d_-]{1,80}$/u.test(t.id) ||
        !families.includes(t.family) ||
        typeof t.request !== 'string' ||
        !t.request.trim() ||
        t.request.length > 8000 ||
        !Array.isArray(t.oracle) ||
        !t.oracle.length ||
        !t.oracle.every((o) => typeof o === 'string' && o.trim()) ||
        t.critical !== true,
    )
  )
    throw new Error('Invalid held-out task contracts');
  const hashes = tasks.map(taskContentHash);
  if (
    new Set(tasks.map((t) => t.id)).size !== 12 ||
    new Set(hashes).size !== 12
  )
    throw new Error('Duplicate held-out task identities/content');
  if (families.some((f) => tasks.filter((t) => t.family === f).length !== 2))
    throw new Error('Two held-out tasks per family required');
  const registered = readJson(
    path.join(root, 'packages/evals/baselines/stage7-real-tasks-v1.json'),
  ).cases;
  const used = new Set(registered.map(taskContentHash));
  if (
    tasks.some(
      (t, i) => used.has(hashes[i]) || registered.some((r) => r.id === t.id),
    )
  )
    throw new Error('Task already used for debugging');
  const verified = verifyBaseline(candidateSnapshot);
  if (!verified.valid) throw new Error('Candidate source integrity failed');
  const candidate = readSealed(candidateSnapshot, 'manifest');
  if (!Number.isFinite(Date.parse(candidate.createdAt)))
    throw new Error('Missing candidate freeze timestamp');
  newDirectory(destination, [root, candidateSnapshot]);
  const payloadHash = seal(destination, 'tasks', { schemaVersion: 1, tasks });
  const reservation = {
    schemaVersion: 1,
    kind: 'reserved-holdout-contracts-not-executed',
    reservedAt: new Date().toISOString(),
    candidateFrozenAt: candidate.createdAt,
    candidateSnapshot,
    candidateSource: verified.fingerprint,
    candidateManifestHash: fileDigest(
      path.join(candidateSnapshot, 'manifest.json'),
    ),
    sourceVerified: true,
    tasksPayloadHash: payloadHash,
    tasks: tasks.map((t, i) => ({
      id: t.id,
      family: t.family,
      contentHash: hashes[i],
    })),
    regressionTasks: registered.map((t) => ({
      id: t.id,
      contentHash: taskContentHash(t),
    })),
    firstExposedAt: null,
    independentReview: false,
    realModelExecutions: 0,
    priorExposures: [],
    debuggingContentHashes: [],
    limitations: [
      'Fresh contracts authored outside product source, not independently blind-reviewed or executed adapters.',
      'A separate directory and write-once hashes do not provide OS isolation; a confined live worker is still required.',
      'Historical exposures from other reservations must be included by the controller; semantic paraphrase detection still requires independent review.',
    ],
  };
  seal(destination, 'reservation', reservation);
  return reservation;
}
export function exposeHoldout(directory, experimentHash, candidateSource) {
  const reservation = readSealed(directory, 'reservation');
  readSealed(directory, 'tasks');
  if (
    fileDigest(path.join(directory, 'tasks.json')) !==
    reservation.tasksPayloadHash
  )
    throw new Error('Holdout payload changed');
  if (
    !digest(experimentHash) ||
    candidateSource !== reservation.candidateSource
  )
    throw new Error('Candidate/experiment mismatch');
  if (existsSync(path.join(directory, 'exposure.json'))) {
    const previous = readSealed(directory, 'exposure');
    if (
      previous.experimentHash !== experimentHash ||
      previous.candidateSource !== candidateSource
    )
      throw new Error('Holdout already exposed/retired for another experiment');
    return previous;
  }
  const event = {
    schemaVersion: 1,
    experimentHash,
    candidateSource,
    exposedAt: new Date().toISOString(),
    reservationHash: fileDigest(path.join(directory, 'reservation.json')),
    taskContentHashes: reservation.tasks.map((t) => t.contentHash),
    retireForFutureExperiments: true,
    permitsProductExecution: false,
  };
  seal(directory, 'exposure', event);
  return event;
}
export function verifiedEvidence(inputRoot, entries) {
  const found = new Set();
  if (!Array.isArray(entries))
    throw new Error('Missing evidence file inventory');
  for (const entry of entries) {
    safeRelative(entry.path);
    if (!entry.path.startsWith('evidence/') || !digest(entry.sha256))
      throw new Error('Invalid evidence entry');
    const absolute = path.join(inputRoot, entry.path);
    assertNoLinks(absolute);
    const stat = lstatSync(absolute);
    if (
      !stat.isFile() ||
      stat.nlink > 1 ||
      fileDigest(absolute) !== entry.sha256
    )
      throw new Error('Raw evidence missing or changed');
    found.add(entry.sha256);
  }
  return found;
}
export async function writeIterationReview(inputFile, destination) {
  if (![inputFile, destination].every(path.isAbsolute))
    throw new Error('Absolute paths required');
  const payload = readJson(inputFile),
    input = payload.review;
  const originalPayload = structuredClone(payload);
  const evidence = verifiedEvidence(
    path.dirname(inputFile),
    payload.evidenceFiles,
  );
  const referenced = [
    ...[input.regression, input.holdout].flatMap((c) =>
      c.records.flatMap((r) => r.evidenceHashes),
    ),
    ...input.classifications.map((c) => c.evidenceHash),
    ...input.safety.observations.map((o) => o.evidenceHash),
  ];
  if (referenced.some((h) => !evidence.has(h)))
    throw new Error('Unverified evidence reference');
  const manifests = {};
  for (const variant of ['before', 'after']) {
    const directory = payload.snapshots[variant];
    if (!path.isAbsolute(directory) || !verifyBaseline(directory).valid)
      throw new Error('Source snapshot verification failed');
    manifests[variant] = readSealed(directory, 'manifest');
    if (
      manifests[variant].source.fingerprint !==
      input.regression.plan[`${variant}Source`]
    )
      throw new Error('Source identity mismatch');
  }
  const before = new Map(
    manifests.before.source.files.map((f) => [f.path, f.sha256]),
  );
  const after = new Map(
    manifests.after.source.files.map((f) => [f.path, f.sha256]),
  );
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
    .filter((p) => before.get(p) !== after.get(p))
    .sort();
  // Do not trust a caller-supplied list that can conceal unrelated edits.
  input.changedFiles = changedFiles;
  const built = await build({
    entryPoints: [path.join(root, 'packages/evals/src/iterationReview.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const evaluator = built.outputFiles[0].text;
  const { reviewIteration } = await import(
    `data:text/javascript;base64,${Buffer.from(evaluator).toString('base64')}`
  );
  const result = reviewIteration(input);
  newDirectory(destination, [
    root,
    path.dirname(inputFile),
    ...Object.values(payload.snapshots),
  ]);
  // Archive every referenced raw file, not just a mutable pointer back to the input.
  for (const entry of payload.evidenceFiles) {
    const target = path.join(destination, entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(
      path.join(path.dirname(inputFile), entry.path),
      target,
      constants.COPYFILE_EXCL,
    );
    if (fileDigest(target) !== entry.sha256)
      throw new Error(
        'Evidence changed during archival; partial output must not be reused',
      );
  }
  seal(destination, 'input', originalPayload);
  const report = {
    ...result,
    inputFileHash: fileDigest(inputFile),
    evaluatorBundleHash: sha(evaluator),
    derivedChangedFiles: changedFiles,
    evidenceIntegrityVerified: true,
    provenanceIndependentlyAttested: false,
    rawEvidenceFiles: payload.evidenceFiles,
    evidenceRoot: destination,
    generatedAt: new Date().toISOString(),
    executedByThisReporter: 0,
  };
  seal(destination, 'report', report);
  return report;
}
/** Offline audit store only. It is not connected to deployment or tool dispatch. */
export async function checkTestPilot(inputFile, pilotDirectory) {
  if (![inputFile, pilotDirectory].every(path.isAbsolute))
    throw new Error('Absolute paths required');
  const payload = readJson(inputFile);
  const originalPayload = structuredClone(payload);
  const input = payload.readiness;
  if (!path.isAbsolute(payload.candidateSnapshot))
    throw new Error('Absolute candidate snapshot required');
  assertNoLinks(pilotDirectory);
  if (
    !outside(pilotDirectory, root) ||
    !outside(pilotDirectory, path.dirname(inputFile)) ||
    !outside(pilotDirectory, payload.candidateSnapshot)
  )
    throw new Error('Pilot audit must be outside input/source directories');
  const existed = existsSync(pilotDirectory);
  if (existed && readSealed(pilotDirectory, 'pilot').pilotId !== input.pilotId)
    throw new Error('Pilot audit identity mismatch');
  // The caller cannot clear a persisted incident by supplying previous=false.
  input.previous =
    existed && existsSync(path.join(pilotDirectory, 'stop-latch.json'))
      ? {
          pilotId: readSealed(pilotDirectory, 'stop-latch').pilotId,
          stopLatched: true,
        }
      : null;
  const built = await build({
    entryPoints: [path.join(root, 'packages/evals/src/testPilotReadiness.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const evaluator = built.outputFiles[0].text;
  const { assessTestPilot } = await import(
    `data:text/javascript;base64,${Buffer.from(evaluator).toString('base64')}`
  );
  let result = assessTestPilot(input);
  if (!existed) {
    newDirectory(pilotDirectory, [
      root,
      path.dirname(inputFile),
      payload.candidateSnapshot,
    ]);
    seal(pilotDirectory, 'pilot', {
      pilotId: input.pilotId,
      kind: 'offline-pilot-audit-not-a-deployment',
      createdAt: new Date().toISOString(),
    });
  }
  if (
    result.stopLatched &&
    !existsSync(path.join(pilotDirectory, 'stop-latch.json'))
  )
    seal(pilotDirectory, 'stop-latch', {
      pilotId: input.pilotId,
      stopLatched: true,
      eventIds: result.incidentIds,
      recordedAt: new Date().toISOString(),
    });
  // Persist a reported incident before expensive QA. Broken evidence/source must
  // not swallow the stop signal and let a later clean input reset admission.
  const evidence = verifiedEvidence(
    path.dirname(inputFile),
    payload.evidenceFiles,
  );
  const refs = [
    input.candidate.clientSha256,
    input.candidate.serverSha256,
    input.humanReview.evidenceHash,
    input.confinement.dispatchFenceRehearsalHash,
    ...input.targets.map((t) => t.testOnlyEvidenceHash),
    input.rollback.clientSha256,
    input.rollback.serverSha256,
    input.rollback.clientBackupSha256,
    input.rollback.serverBackupSha256,
    input.rollback.runbookHash,
    input.rollback.rehearsal?.evidenceHash,
    input.monitoring.evidenceHash,
    ...input.events.map((e) => e.evidenceHash),
    ...(input.evaluation
      ? [input.evaluation.regression, input.evaluation.holdout].flatMap((c) =>
          c.records.flatMap((r) => r.evidenceHashes),
        )
      : []),
    ...(input.evaluation?.safety.observations.map((o) => o.evidenceHash) ?? []),
  ].filter((h) => h !== null && h !== undefined);
  if (refs.some((h) => !evidence.has(h)))
    throw new Error('Unverified pilot evidence reference');
  if (
    !verifyBaseline(payload.candidateSnapshot).valid ||
    readSealed(payload.candidateSnapshot, 'manifest').source.fingerprint !==
      input.candidate.sourceFingerprint
  )
    throw new Error('Pilot candidate source integrity failed');
  if (existsSync(path.join(pilotDirectory, 'stop-latch.json'))) {
    input.previous = {
      pilotId: readSealed(pilotDirectory, 'stop-latch').pilotId,
      stopLatched: true,
    };
    result = assessTestPilot(input);
  }
  const directory = path.join(pilotDirectory, `check-${randomUUID()}`);
  newDirectory(directory);
  for (const entry of payload.evidenceFiles) {
    const target = path.join(directory, entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(
      path.join(path.dirname(inputFile), entry.path),
      target,
      constants.COPYFILE_EXCL,
    );
    if (fileDigest(target) !== entry.sha256)
      throw new Error('Pilot evidence changed during archival');
  }
  seal(directory, 'input', originalPayload);
  const report = {
    ...result,
    kind: 'offline-pilot-readiness',
    directory,
    evidenceIntegrityVerified: true,
    evaluatorBundleHash: sha(evaluator),
    generatedAt: new Date().toISOString(),
    rawEvidenceFiles: payload.evidenceFiles,
  };
  seal(directory, 'report', report);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [command, ...args] = process.argv.slice(2);
    let result;
    if (command === 'reserve' && args.length === 3)
      result = reserveHoldout(...args);
    else if (command === 'expose' && args.length === 3)
      result = exposeHoldout(...args);
    else if (command === 'review' && args.length === 2)
      result = await writeIterationReview(...args);
    else if (command === 'pilot-check' && args.length === 2)
      result = await checkTestPilot(...args);
    else
      throw new Error(
        'Usage: reserve ABS_TASKS_JSON ABS_CANDIDATE_SNAPSHOT ABS_NEW_DIR | expose ABS_RESERVED_DIR EXPERIMENT_SHA256 CANDIDATE_SHA256 | review ABS_INPUT_JSON ABS_NEW_DIR | pilot-check ABS_INPUT_JSON ABS_PILOT_AUDIT_DIR',
      );
    console.log(
      JSON.stringify({
        kind: result.kind ?? 'offline-iteration-record',
        admission: result.admission ?? result.state ?? 'not_executed',
        reportDirectory: result.directory,
        tasks: result.tasks?.length,
        realModelExecutions: 0,
        productionReleaseAllowed: false,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
