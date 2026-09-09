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
function runSize(bytes) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'otto-source-budget-'));
  try {
    mkdirSync(path.join(fixture, 'packages'));
    writeFileSync(
      path.join(fixture, 'packages/payload.json'),
      Buffer.alloc(bytes, 32),
    );
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
  it('retains the new feature sources and audit evidence within 44 MiB', () => {
    const result = runSize(44 * 1024 * 1024);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('budget: 44.00 MB');
  });
  it('still rejects one byte beyond the documented ceiling', () => {
    const result = runSize(44 * 1024 * 1024 + 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exceeds 44.00 MB');
  });
  it('keeps an explicit independent whole-checkout budget for doctor', () => {
    const doctor = readFileSync(path.join(repo, 'scripts/doctor.cjs'), 'utf8');
    expect(doctor).toContain('OTTO_DOCTOR_SOURCE_SIZE_BUDGET_MB || 52');
    const report = readFileSync(
      path.join(repo, 'scripts/source-size-report.mjs'),
      'utf8',
    );
    expect(report).toContain('textHardBytes: 300 * 1024');
    expect(report).toContain('duplicateBytes: 100 * 1024');
  });
});
