/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  reserveHoldout,
  exposeHoldout,
  taskContentHash,
  verifiedEvidence,
  writeIterationReview,
  checkTestPilot,
} from '../review-agent-iteration.mjs';
import { seal, sha, readSealed } from '../agent-experiment-files.mjs';
import { hashEntries } from '../agent-eval-baseline.mjs';
const temporary = [];
function fixture(source = 'export const fixture = true;') {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-iteration-unit-'));
  temporary.push(root);
  const snapshot = path.join(root, 'snapshot');
  mkdirSync(path.join(snapshot, 'source'), { recursive: true });
  writeFileSync(path.join(snapshot, 'source/app.ts'), source);
  const files = [
    {
      path: 'app.ts',
      bytes: Buffer.byteLength(source),
      sha256: sha(source),
      state: 'untracked',
    },
  ];
  seal(snapshot, 'manifest', {
    schemaVersion: 1,
    kind: 'offline-source-baseline',
    createdAt: '2026-09-08T00:00:00Z',
    source: { files, fingerprint: hashEntries(files) },
  });
  const tasks = [
    'code_repair',
    'file_delivery',
    'gui',
    'restart',
    'steering',
    'enterprise',
  ].flatMap((family) =>
    [1, 2].map((i) => ({
      id: `${family}-${i}`,
      family,
      request: `Unseen fixture ${family} ${i}`,
      oracle: ['independent state'],
      critical: true,
      adapter: 'not_implemented',
    })),
  );
  const input = path.join(root, 'tasks.json');
  writeFileSync(input, JSON.stringify({ tasks }));
  return {
    root,
    snapshot,
    input,
    tasks,
    destination: path.join(root, 'reserved'),
  };
}
afterEach(() => {
  for (const root of temporary.splice(0)) {
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('otto-iteration-unit-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
it('pilot-check persists a stop across checks and cannot clear it by deleting incidents in new input', async () => {
  const f = fixture();
  const inputRoot = path.join(f.root, 'pilot-input');
  mkdirSync(inputRoot);
  const inputFile = path.join(inputRoot, 'readiness.json');
  const sourceFingerprint = readSealed(f.snapshot, 'manifest').source
    .fingerprint;
  const payload = {
    candidateSnapshot: f.snapshot,
    evidenceFiles: [],
    readiness: {
      pilotId: 'fixture-pilot',
      candidate: {
        sourceFingerprint,
        version: null,
        clientSha256: null,
        serverChanged: false,
        serverSha256: null,
      },
      evaluation: null,
      humanReview: { approved: false, reviewer: null, evidenceHash: null },
      targets: [],
      confinement: {
        dedicatedClientProfile: false,
        testApiOnly: false,
        manualInstallOnly: true,
        dispatchFenceRehearsalHash: null,
      },
      rollback: {
        clientSha256: null,
        serverSha256: null,
        clientBackupSha256: null,
        serverBackupSha256: null,
        owner: null,
        runbookHash: null,
        rehearsal: null,
      },
      monitoring: { complete: false, evidenceHash: null },
      events: [],
      previous: null,
    },
  };
  const output = path.join(f.root, 'pilot-audit');
  writeFileSync(inputFile, JSON.stringify(payload));
  const first = await checkTestPilot(inputFile, output);
  expect(first.state).toBe('blocked');
  expect(first.executionPerformed).toBe(false);
  payload.readiness.events.push({
    id: 'fixture-incident',
    kind: 'duplicate_send',
    suspected: true,
    evidenceHash: null,
  });
  writeFileSync(inputFile, JSON.stringify(payload));
  writeFileSync(path.join(f.snapshot, 'source/app.ts'), 'corrupt source');
  await expect(checkTestPilot(inputFile, output)).rejects.toThrow(
    /source integrity/,
  );
  expect(readSealed(output, 'stop-latch').stopLatched).toBe(true);
  writeFileSync(
    path.join(f.snapshot, 'source/app.ts'),
    'export const fixture = true;',
  );
  const stopped = await checkTestPilot(inputFile, output);
  expect(stopped.state).toBe('stopped');
  expect(readSealed(output, 'stop-latch').stopLatched).toBe(true);
  payload.readiness.events = [];
  payload.readiness.previous = {
    pilotId: payload.readiness.pilotId,
    stopLatched: false,
  };
  writeFileSync(inputFile, JSON.stringify(payload));
  const later = await checkTestPilot(inputFile, output);
  expect(later.state).toBe('stopped');
  expect(later.directory).not.toBe(stopped.directory);
  expect(readSealed(first.directory, 'report').state).toBe('blocked');
  payload.readiness.pilotId = 'replacement-pilot';
  writeFileSync(inputFile, JSON.stringify(payload));
  await expect(checkTestPilot(inputFile, output)).rejects.toThrow(/identity/);
});
it('reserves a new external corpus without claiming real execution or blind review', () => {
  const f = fixture(),
    result = reserveHoldout(f.input, f.snapshot, f.destination);
  expect(result.tasks).toHaveLength(12);
  expect(result.independentReview).toBe(false);
  expect(result.realModelExecutions).toBe(0);
  expect(result.firstExposedAt).toBeNull();
  expect(readSealed(f.destination, 'reservation').candidateSource).toBe(
    hashEntries(readSealed(f.snapshot, 'manifest').source.files),
  );
  expect(() => reserveHoldout(f.input, f.snapshot, f.destination)).toThrow(
    /exists|overwrite/,
  );
});
it('task fingerprints ignore names, whitespace and oracle order, not the actual acceptance rules', () => {
  const f = fixture(),
    task = f.tasks[0];
  expect(
    taskContentHash({
      ...task,
      id: 'renamed',
      request: `  ${task.request} \n`,
    }),
  ).toBe(taskContentHash(task));
  expect(taskContentHash({ ...task, oracle: ['a', 'b'] })).toBe(
    taskContentHash({ ...task, oracle: ['b', 'a'] }),
  );
  expect(taskContentHash({ ...task, oracle: ['weaker'] })).not.toBe(
    taskContentHash(task),
  );
});
it('rejects source tampering, duplicate content and malformed task oracles', () => {
  const f = fixture();
  f.tasks[1] = { ...f.tasks[0], id: 'renamed' };
  writeFileSync(f.input, JSON.stringify({ tasks: f.tasks }));
  expect(() => reserveHoldout(f.input, f.snapshot, f.destination)).toThrow(
    /duplicate/i,
  );
  f.tasks[1].oracle = [];
  writeFileSync(f.input, JSON.stringify({ tasks: f.tasks }));
  expect(() => reserveHoldout(f.input, f.snapshot, f.destination)).toThrow(
    /task/i,
  );
  const g = fixture();
  writeFileSync(path.join(g.snapshot, 'source/app.ts'), 'tampered');
  expect(() => reserveHoldout(g.input, g.snapshot, g.destination)).toThrow(
    /source/i,
  );
});
it('writes a single exposure event, rejects another experiment/candidate, and detects altered tasks', () => {
  const f = fixture(),
    reserved = reserveHoldout(f.input, f.snapshot, f.destination);
  expect(() =>
    exposeHoldout(f.destination, sha('experiment'), sha('other-source')),
  ).toThrow(/candidate/i);
  const result = exposeHoldout(
    f.destination,
    sha('experiment'),
    reserved.candidateSource,
  );
  expect(result.candidateSource).toBe(reserved.candidateSource);
  expect(
    exposeHoldout(f.destination, sha('experiment'), reserved.candidateSource),
  ).toEqual(result);
  expect(() =>
    exposeHoldout(
      f.destination,
      sha('another-experiment'),
      reserved.candidateSource,
    ),
  ).toThrow(/retired|exposed/i);
  writeFileSync(path.join(f.destination, 'tasks.json'), '{}');
  expect(() =>
    exposeHoldout(f.destination, sha('experiment'), reserved.candidateSource),
  ).toThrow(/changed/i);
});
it('raw evidence must exist, match its hash and stay inside the supplied evidence root', () => {
  const f = fixture();
  mkdirSync(path.join(f.root, 'evidence'));
  writeFileSync(path.join(f.root, 'evidence/trace.json'), '{"native":true}');
  expect(
    verifiedEvidence(f.root, [
      { path: 'evidence/trace.json', sha256: sha('{"native":true}') },
    ]),
  ).toEqual(new Set([sha('{"native":true}')]));
  expect(() =>
    verifiedEvidence(f.root, [{ path: '../escape', sha256: sha('x') }]),
  ).toThrow();
  expect(() =>
    verifiedEvidence(f.root, [
      { path: 'evidence/trace.json', sha256: sha('wrong') },
    ]),
  ).toThrow(/evidence/i);
  expect(JSON.parse(readFileSync(f.input, 'utf8')).tasks).toHaveLength(12);
});
it('the offline entry archives raw files, derives all actual changes, retains not-run slots and refuses overwrites', async () => {
  const before = fixture(),
    after = fixture('export const fixture = false;');
  const inputRoot = path.join(before.root, 'input');
  mkdirSync(path.join(inputRoot, 'evidence'), { recursive: true });
  const beforeSource = readSealed(before.snapshot, 'manifest').source
    .fingerprint;
  const afterSource = readSealed(after.snapshot, 'manifest').source.fingerprint;
  const cohort = (prefix, experiment) => ({
    conditionsHash: sha('conditions'),
    records: [],
    plan: {
      beforeSource,
      afterSource,
      experimentHash: sha(experiment),
      repeats: 1,
      cases: before.tasks.map((t) => ({
        id: prefix + t.id,
        family: t.family,
        critical: true,
      })),
    },
  });
  const regression = cohort('dev-', 'dev'),
    holdout = cohort('new-', 'new');
  const review = {
    roundId: 'fixture-round',
    parentReportHash: sha('prior'),
    regression,
    holdout,
    classifications: [],
    focus: null,
    changedFiles: [],
    holdoutReservation: {
      candidateFrozenAt: '2026-09-08T01:00:00Z',
      reservedAt: '2026-09-08T00:00:00Z',
      firstExposedAt: null,
      independentReview: false,
      tasks: holdout.plan.cases.map((c) => ({
        id: c.id,
        contentHash: sha(c.id),
      })),
      regressionTasks: regression.plan.cases.map((c) => ({
        id: c.id,
        contentHash: sha(c.id),
      })),
      priorExposures: [],
      debuggingContentHashes: [],
    },
    safety: {
      sourceFingerprint: afterSource,
      required: [
        'no-external-open',
        'no-path-escape',
        'no-false-delivery',
        'no-replay',
      ],
      observations: [],
    },
    performanceExplanations: {},
  };
  const raw = '{"fixture":"preflight, not a real model trace"}';
  writeFileSync(path.join(inputRoot, 'evidence/trace.json'), raw);
  const payload = {
    review,
    snapshots: { before: before.snapshot, after: after.snapshot },
    evidenceFiles: [{ path: 'evidence/trace.json', sha256: sha(raw) }],
  };
  const inputFile = path.join(inputRoot, 'iteration.json');
  writeFileSync(inputFile, JSON.stringify(payload));
  const destination = path.join(before.root, 'report');
  const result = await writeIterationReview(inputFile, destination);
  expect(result.admission).toBe('blocked');
  expect(result.executedByThisReporter).toBe(0);
  expect(result.derivedChangedFiles).toEqual(['app.ts']);
  expect(result.unscopedChanges).toEqual(['app.ts']);
  expect(result.regression.after.notRun).toBe(12);
  expect(result.holdout.after.firstPassRate).toBeNull();
  expect(readSealed(destination, 'input').review.changedFiles).toEqual([]);
  writeFileSync(path.join(inputRoot, 'evidence/trace.json'), 'changed later');
  expect(
    readFileSync(path.join(destination, 'evidence/trace.json'), 'utf8'),
  ).toBe(raw);
  writeFileSync(path.join(inputRoot, 'evidence/trace.json'), raw);
  await expect(writeIterationReview(inputFile, destination)).rejects.toThrow(
    /exists|overwrite/,
  );
});
