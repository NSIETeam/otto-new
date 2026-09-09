/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

it('retains actual desktop coverage after a completed test step without bypassing its result', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs['build-and-test'].steps;
  const test = steps.find(step => step.id === 'desktop_tests');
  const upload = steps.find(step => step.name === 'Preserve desktop coverage measurement');
  expect(test.run).toBe('npm run test:coverage --workspace=packages/desktop');
  expect(test['continue-on-error']).toBeUndefined();
  expect(upload.if).toBe("${{ always() && (steps.desktop_tests.outcome == 'success' || steps.desktop_tests.outcome == 'failure') && hashFiles('packages/desktop/coverage/coverage-final.json') != '' }}");
  expect(upload.with.path).toBe('packages/desktop/coverage/coverage-final.json');
  expect(upload.with.name).toBe('desktop-coverage-${{ github.sha }}');
  expect(upload.with['if-no-files-found']).toBe('error');
  expect(upload.with['retention-days']).toBe(14);
  expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
  expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(test));
});
