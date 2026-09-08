import { describe, it, expect } from 'vitest';
import { summarizeVitestReport } from '../run-agent-baseline.mjs';
import { readFileSync } from 'node:fs';

describe('baseline observations cannot masquerade as quality scores', () => {
  it('keeps missing reports and empty green reports unsuccessful', () => {
    expect(summarizeVitestReport(undefined).status).toBe('no_valid_report');
    expect(
      summarizeVitestReport({ success: true, testResults: [] }).status,
    ).toBe('failed');
  });
  it('preserves failures and skipped cases, including collection failure', () => {
    const r = summarizeVitestReport({
      success: false,
      testResults: [
        {
          name: 'a',
          status: 'failed',
          assertionResults: [
            { title: 'one', status: 'passed' },
            { title: 'two', status: 'failed', failureMessages: ['failure'] },
            { title: 'three', status: 'pending' },
          ],
        },
        { name: 'collection-error', status: 'failed', assertionResults: [] },
      ],
    });
    expect(r).toMatchObject({
      status: 'failed',
      passed: 1,
      failed: 1,
      skipped: 1,
      failedSuites: 2,
    });
    expect(r.suites).toHaveLength(2);
  });
  it('registers eight unique contracts, not fake completed real-model tasks', () => {
    const rules = JSON.parse(
      readFileSync(
        new URL(
          '../../packages/evals/baselines/semantic-stage0-v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(rules.status).toBe('acceptance_registered_not_live_measured');
    expect(rules.cases).toHaveLength(8);
    expect(new Set(rules.cases.map((c) => c.id)).size).toBe(8);
    expect(rules.cases.filter((c) => c.split === 'reserved')).toHaveLength(2);
    for (const c of rules.cases) {
      expect(c.must.length).toBeGreaterThan(0);
      expect(c.mustNot.length).toBeGreaterThan(0);
      expect(c.negativeVariants.length).toBeGreaterThan(0);
      expect(c.oracle.length).toBeGreaterThan(10);
      expect(c.evidenceStatus).toBeTruthy();
    }
    expect(rules.budget.maxCostUsd).toBeNull();
  });
});
