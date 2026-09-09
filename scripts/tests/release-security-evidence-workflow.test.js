/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
    'utf8',
  ),
);
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
const find = (name) => steps.find((step) => step.name === name);

describe('release security evidence lifecycle', () => {
  it('preserves the live audit JSON even when strict verification fails', () => {
    const audit = find('Enforce release dependency audit');
    const upload = find('Preserve release dependency audit diagnostics');
    expect(audit.id).toBe('release_dependency_audit');
    expect(audit.run).toBe(
      'npm run security:dependencies:release -- --diagnostic-json artifacts/security/release-dependency-audit.json',
    );
    expect(audit['continue-on-error']).toBeUndefined();
    expect(upload.if).toBe(
      "${{ always() && (steps.release_dependency_audit.outcome == 'success' || steps.release_dependency_audit.outcome == 'failure') }}",
    );
    expect(upload.with.path).toBe(
      'artifacts/security/release-dependency-audit.json',
    );
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with['retention-days']).toBe(14);
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
  });

  it('skips unrun E2EE evidence, saves failed-test evidence, and errors if a run did not produce its report', () => {
    const check = find(
      'Verify hostile-server defenses and E2EE release authorization',
    );
    const upload = find('Preserve E2EE adversarial evidence');
    expect(check.id).toBe('e2ee_release_verification');
    expect(check['continue-on-error']).toBeUndefined();
    expect(upload.if).toBe(
      "${{ always() && (steps.e2ee_release_verification.outcome == 'success' || steps.e2ee_release_verification.outcome == 'failure') }}",
    );
    expect(upload.with.path).toBe(
      'artifacts/security/e2ee-adversarial-report.json',
    );
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(steps.indexOf(check)).toBeGreaterThan(
      steps.indexOf(find('Enforce release dependency audit')),
    );
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(check));
  });
});
