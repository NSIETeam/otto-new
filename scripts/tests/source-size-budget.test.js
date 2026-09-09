/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../..');
function runSize(bytes, payload = 'packages/payload.json') {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'otto-source-budget-'));
  try {
    mkdirSync(path.dirname(path.join(fixture, payload)), { recursive: true });
    writeFileSync(path.join(fixture, payload), Buffer.alloc(bytes, 32));
    return spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/source-size-report.mjs'), '--check'],
      {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('reviewed 1.9.15 source budget (not installer size)', () => {
  it('retains the new feature sources and reviewed measurement evidence within 47 MiB', () => {
    const result = runSize(47 * 1024 * 1024);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('budget: 47.00 MB');
  });
  it('still rejects one byte beyond the documented ceiling', () => {
    const result = runSize(47 * 1024 * 1024 + 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exceeds 47.00 MB');
  });
  it('counts compressed reviewed coverage evidence rather than hiding it as generated output', () => {
    const result = runSize(
      47 * 1024 * 1024 + 1,
      'config/test-baselines/desktop/evidence.json.gz',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exceeds 47.00 MB');
  });
  it('keeps an explicit independent whole-checkout budget for doctor', () => {
    const doctor = readFileSync(path.join(repo, 'scripts/doctor.cjs'), 'utf8');
    expect(doctor).toContain('OTTO_DOCTOR_SOURCE_SIZE_BUDGET_MB || 55');
    const report = readFileSync(
      path.join(repo, 'scripts/source-size-report.mjs'),
      'utf8',
    );
    expect(report).toContain('textHardBytes: 300 * 1024');
    expect(report).toContain('duplicateBytes: 100 * 1024');
  });
});
