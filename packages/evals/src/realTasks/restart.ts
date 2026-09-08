/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scriptedProvider } from './loopbackProvider.js';
import { EvidenceJournal } from './evidence.js';
import type { TurnRecoveryRecord } from '../../../server/src/turnRecoveryStore.js';
import type { ServerToClient } from '../../../server/src/protocol.js';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function hasNativeReconciliation(frames: ServerToClient[]): boolean {
  return frames.some(
    (frame) =>
      (frame.type === 'error' &&
        JSON.stringify(frame.payload).includes(
          'recovery_reconciliation_required',
        )) ||
      (frame.type === 'turn_event' &&
        frame.payload.snapshot?.items.some(
          (item) =>
            item.id === 'turn-reconciliation-required' &&
            item.type === 'notice' &&
            item.status === 'awaiting_confirmation' &&
            item.level === 'warning',
        )),
  );
}

export async function executeRestartProbe(input: {
  caseId: 'restart-known-receipt' | 'restart-unknown-outcome';
  root: string;
  sourceRoot: string;
  sourceFingerprint: string;
  experimentHash: string;
}) {
  await mkdir(input.root);
  const journal = new EvidenceJournal(
    path.join(input.root, 'controller-evidence'),
  );
  const received: Array<{ at: number; body: string }> = [];
  let secondRound = false;
  let resume = false;
  const receiver = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/receipt') {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).length > 10000) {
        response.destroy();
        return;
      }
    }
    received.push({ at: Date.now(), body: Buffer.concat(chunks).toString() });
    if (input.caseId === 'restart-known-receipt')
      response.end(
        JSON.stringify({ receiptId: 'independent-receipt-1', accepted: true }),
      );
    // Unknown case deliberately commits before withholding the transport reply.
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, '127.0.0.1', resolve),
  );
  const receiverAddress = receiver.address();
  if (!receiverAddress || typeof receiverAddress === 'string')
    throw new Error('No receiver');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resumeCalls = 0;
  const provider = await scriptedProvider(async (round) => {
    if ((!resume && round === 1) || (resume && resumeCalls++ === 0))
      return { name: 'eval_send_receipt', args: {} };
    if (!resume) {
      secondRound = true;
      await held;
    }
    return '请依据已保存的回执核对结果，不重复发送。';
  });
  const runDirectory = path.join(input.root, 'product-run');
  const base = {
    caseId: input.caseId,
    runDirectory,
    model: provider.model,
    mode: 'scripted' as const,
    experimentHash: input.experimentHash,
    sourceFingerprint: input.sourceFingerprint,
    receiver: `http://127.0.0.1:${receiverAddress.port}/receipt`,
    recovery: true,
  };
  let child: ChildProcess | undefined;
  const lifecycle: Array<{
    event: string;
    pid?: number;
    at: number;
    exitCode?: number | null;
  }> = [];
  const launch = async (resumed: boolean) => {
    const requestFile = path.join(
      input.root,
      resumed ? 'worker-resume.json' : 'worker-first.json',
    );
    await writeFile(requestFile, JSON.stringify({ ...base, resume: resumed }), {
      flag: 'wx',
    });
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      'SystemRoot',
      'WINDIR',
      'PATH',
      'Path',
      'TEMP',
      'TMP',
      'PATHEXT',
    ])
      if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, {
      OTTO_REAL_TASK_WORKER: requestFile,
      OTTO_USER_DIR: path.join(runDirectory, 'profile'),
      OTTO_LIVE_EVAL: '0',
      OTTO_DISABLE_MODEL_HEALTH_CHECK: '1',
      CI: '1',
      NO_COLOR: '1',
    });
    child = spawn(
      process.execPath,
      [
        path.join(input.sourceRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'scripts/agent-real-worker.vitest.config.mjs',
        '--silent',
      ],
      {
        cwd: input.sourceRoot,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const launched = child;
    let logs = '';
    launched.stdout!.on('data', (b) => {
      logs = (logs + String(b)).slice(-32000);
    });
    launched.stderr!.on('data', (b) => {
      logs = (logs + String(b)).slice(-32000);
    });
    lifecycle.push({
      event: resumed ? 'restart' : 'start',
      pid: launched.pid,
      at: Date.now(),
    });
    const done = new Promise<number | null>((resolve, reject) => {
      launched.once('error', reject);
      launched.once('exit', (code) => {
        lifecycle.push({
          event: 'exit',
          pid: launched.pid,
          at: Date.now(),
          exitCode: code,
        });
        resolve(code);
      });
    });
    return { launched, done, logs: () => logs };
  };
  try {
    const first = await launch(false);
    let checkpoint: TurnRecoveryRecord | undefined;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (first.launched.exitCode !== null) {
        await journal.add('worker-exited-before-interruption.json', {
          received: received.length,
          providerCalls: provider.calls(),
          workerLog: first.logs(),
        });
        throw new Error(`Worker exited before interruption: ${first.logs()}`);
      }
      try {
        const dir = path.join(runDirectory, 'recovery');
        const file = (await readdir(dir)).find((n) => n.endsWith('.json'));
        if (file)
          checkpoint = JSON.parse(
            await readFile(path.join(dir, file), 'utf8'),
          ) as TurnRecoveryRecord;
      } catch {
        /* atomic write not ready */
      }
      const expected =
        input.caseId === 'restart-known-receipt' ? 'succeeded' : 'started';
      if (
        received.length === 1 &&
        checkpoint?.tools.some(
          (t) => t.name === 'eval_send_receipt' && t.state === expected,
        ) &&
        (expected === 'started' || secondRound)
      )
        break;
      await delay(100);
    }
    const expectedState =
      input.caseId === 'restart-known-receipt' ? 'succeeded' : 'started';
    if (
      received.length !== 1 ||
      !checkpoint?.tools.some(
        (t) => t.name === 'eval_send_receipt' && t.state === expectedState,
      )
    ) {
      await journal.add('interruption-not-reached.json', {
        received: received.length,
        providerCalls: provider.calls(),
        secondRound,
        checkpoint,
        workerLog: first.logs(),
      });
      throw new Error('Did not reach the required REAL crash point');
    }
    const snapshot = await journal.add(
      'before-crash-recovery.json',
      checkpoint,
    );
    lifecycle.push({
      event: 'terminate-owned-process',
      pid: first.launched.pid,
      at: Date.now(),
    });
    first.launched.kill('SIGKILL');
    await first.done;
    resume = true;
    release();
    const second = await launch(true);
    const timeout = setTimeout(() => second.launched.kill('SIGKILL'), 60000);
    const code = await second.done;
    clearTimeout(timeout);
    await journal.add('restart-worker-log.json', { code, tail: second.logs() });
    const output = JSON.parse(
      await readFile(path.join(input.root, 'resumed.json'), 'utf8'),
    );
    const frames = JSON.parse(
      await readFile(
        path.join(runDirectory, 'resume-evidence/product-frames.json'),
        'utf8',
      ),
    ) as ServerToClient[];
    const framesFile = await journal.add('after-restart-frames.json', frames);
    const lifeFile = await journal.add('process-lifecycle.json', lifecycle);
    const countFile = await journal.add('independent-receiver.json', {
      requests: received,
      deduplicates: false,
    });
    const restoredToolReceipt = frames.some(
      (f) =>
        f.type === 'tool_calls_update' &&
        f.payload.toolCalls.some(
          (t) =>
            t.toolName === 'eval_send_receipt' &&
            t.status === 'success' &&
            JSON.stringify(t.result).includes('independent-receipt-1'),
        ),
    );
    // A model saying "核对" is not a native recovery-gate observation.
    const nativeReconciliation = hasNativeReconciliation(frames);
    const known = input.caseId === 'restart-known-receipt';
    return await journal.finish(
      input.caseId,
      [
        {
          check: 'process-restart',
          passed: code === 0 && first.launched.pid !== second.launched.pid,
          evidence: [lifeFile],
        },
        {
          check: 'receiver-count',
          passed: received.length === 1,
          evidence: [countFile],
        },
        {
          check: 'recovery-record',
          passed: Boolean(checkpoint?.continuity),
          evidence: [snapshot, framesFile],
        },
        {
          check: known ? 'receipt-reused' : 'reconciliation-required',
          passed: known
            ? restoredToolReceipt && received.length === 1
            : nativeReconciliation && received.length === 1,
          evidence: [framesFile, countFile],
        },
      ],
      {
        mode: 'scripted',
        sourceFingerprint: input.sourceFingerprint,
        experimentHash: input.experimentHash,
        productCompleted: output.productCompleted,
        status: 'executed',
      },
    );
  } finally {
    release();
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await provider.close();
  }
}
