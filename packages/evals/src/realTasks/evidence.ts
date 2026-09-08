/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const REAL_TASK_CHECKS = {
  'login-retry': ['source-diff', 'hidden-tests', 'payment-regression'],
  'utc-display': ['source-diff', 'hidden-tests', 'timezone-boundaries'],
  'ppt-preview': [
    'ppt-content',
    'preview-click',
    'preview-screenshot',
    'external-process-monitor',
    'no-bare-path',
  ],
  'dual-artifact': [
    'ppt-content',
    'pdf-content',
    'current-hashes',
    'corruption-control',
    'preview-click',
    'preview-screenshot',
    'external-process-monitor',
  ],
  'steer-stop-backend': [
    'steering-applied',
    'post-steer-writes',
    'retained-work',
  ],
  'steer-replace-artifact': [
    'steering-applied',
    'pdf-content',
    'cancelled-old-action',
    'post-steer-writes',
  ],
  'restart-known-receipt': [
    'process-restart',
    'receiver-count',
    'recovery-record',
    'receipt-reused',
  ],
  'restart-unknown-outcome': [
    'process-restart',
    'receiver-count',
    'recovery-record',
    'reconciliation-required',
  ],
  'inbox-read-return': [
    'ui-clicks',
    'ui-screenshot',
    'persistent-conversation',
    'no-repeat-unread',
  ],
  'project-delete': [
    'ui-clicks',
    'ui-screenshot',
    'project-removed',
    'files-retained',
    'other-session-retained',
  ],
  'park-replies': [
    'api-responses',
    'ticket-conversation',
    'staff-identities',
    'ui-clicks',
    'ui-screenshot',
    'no-repeat-unread',
  ],
  'tenant-boundary': [
    'api-responses',
    'own-profile-persisted',
    'cross-tenant-denied',
    'private-fields-hidden',
  ],
} as const;
export type RealTaskId = keyof typeof REAL_TASK_CHECKS;
export type Observation = {
  check: string;
  passed: boolean | null;
  evidence: string[];
  reason?: string;
};
export type EvidenceFile = { path: string; sha256: string; bytes: number };
export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

/** Test-only IO boundary. Reject symlinks/junctions, hard links and path escapes. */
export async function confinedFile(
  root: string,
  requested: string,
  mustExist = true,
) {
  const base = await realpath(root);
  const target = path.resolve(base, requested);
  const relative = path.relative(base, target);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    /[:\0]/u.test(relative)
  )
    throw new Error('Outside isolated workspace');
  let current = base;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        (stat.isFile() && stat.nlink > 1) ||
        (index < parts.length - 1 && !stat.isDirectory())
      )
        throw new Error('Unsafe linked path');
    } catch (error) {
      if (!mustExist && (error as NodeJS.ErrnoException).code === 'ENOENT')
        continue;
      throw error;
    }
  }
  return target;
}

/** Located OUTSIDE the model's workspace. Every evidence item is write-once. */
export class EvidenceJournal {
  private entries: EvidenceFile[] = [];
  private sealed = false;
  constructor(readonly directory: string) {}
  async add(name: string, value: unknown, binary = false): Promise<string> {
    if (this.sealed || !/^[a-z\d][a-z\d_.-]{0,100}$/iu.test(name))
      throw new Error('Invalid/sealed evidence name');
    await mkdir(this.directory, { recursive: true });
    const data = binary
      ? Buffer.from(value as Uint8Array)
      : Buffer.from(JSON.stringify(value, null, 2));
    await writeFile(path.join(this.directory, name), data, {
      flag: 'wx',
      mode: 0o600,
    });
    this.entries.push({ path: name, sha256: sha256(data), bytes: data.length });
    return name;
  }
  async finish<T extends Record<string, unknown>>(
    caseId: RealTaskId,
    observations: Observation[],
    metadata: T,
  ) {
    if (this.sealed) throw new Error('Evidence already sealed');
    if (new Set(observations.map((o) => o.check)).size !== observations.length)
      throw new Error('Duplicate observation');
    if (
      observations.some(
        (o) =>
          !(REAL_TASK_CHECKS[caseId] as readonly string[]).includes(o.check),
      )
    )
      throw new Error('Observation does not belong to this task');
    const checks = REAL_TASK_CHECKS[caseId].map(
      (check) =>
        observations.find((o) => o.check === check) ?? {
          check,
          passed: null,
          evidence: [],
          reason: 'Required observation unavailable',
        },
    );
    const files = [...this.entries];
    for (const item of files) {
      const bytes = await readFile(
        await confinedFile(this.directory, item.path),
      );
      if (sha256(bytes) !== item.sha256)
        throw new Error('Evidence changed before sealing');
    }
    const complete = checks.every(
      (c) =>
        c.passed !== null &&
        c.evidence.length > 0 &&
        c.evidence.every((e) => files.some((f) => f.path === e)),
    );
    const result = {
      schemaVersion: 1,
      ...metadata,
      caseId,
      checks,
      files,
      traceComplete: complete,
      independentPass: checks.some((c) => c.passed === false)
        ? false
        : complete
          ? true
          : null,
      humanReview: 'pending',
      productionReleaseAllowed: false,
    };
    await this.add('result.json', result);
    this.sealed = true;
    return result;
  }
}
