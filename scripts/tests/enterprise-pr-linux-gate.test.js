/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const read = (relative) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const ci = parse(read('.github/workflows/ci.yml'));
const release = parse(read('.github/workflows/release.yml'));
const fixture = read('scripts/tests/enterprise-ci-linux-integration.sh');
const jobId = 'linux-enterprise-deployment-integration';

describe('PR Linux root gateway acceptance wiring', () => {
  it('runs on every target PR with only read access and no deployment credentials', () => {
    expect(ci.on.pull_request.branches).toEqual(['internal', 'main']);
    const job = ci.jobs[jobId];
    expect(job).toBeDefined();
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(10);
    expect(job.permissions).toEqual({ contents: 'read' });
    for (const key of ['if', 'needs', 'environment', 'continue-on-error']) {
      expect(job[key]).toBeUndefined();
    }
    const checkout = job.steps[0];
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with).toEqual({
      ref: '${{ github.sha }}',
      'fetch-depth': 1,
      'persist-credentials': false,
      submodules: false,
      lfs: false,
    });
    expect(JSON.stringify(job)).not.toMatch(
      /secrets\.|secrets:|id-token|attestations|production-|DEPLOY_SSH|ssh-agent|pull_request_target/,
    );
  });

  it('executes the same pinned offline container gate as release, without an allow-failure path', () => {
    const job = ci.jobs[jobId];
    expect(job).toBeDefined();
    const gate = job.steps.find(
      (step) => step.id === 'linux_gateway_integration',
    );
    const releaseGate = release.jobs[jobId].steps.find((step) =>
      step.run?.includes('docker run'),
    );
    expect(gate).toBeDefined();
    expect(gate.shell).toBe('bash');
    expect(gate.if).toBeUndefined();
    expect(gate['continue-on-error']).toBeUndefined();
    expect(gate.env).toEqual({ TEST_COMMIT: '${{ github.sha }}' });
    expect(gate.run).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
    expect(gate.run).toContain('test "$RUNNER_OS" = Linux');
    expect(gate.run).toContain('test "$(git rev-parse HEAD)" = "$TEST_COMMIT"');
    expect(gate.run).toContain(releaseGate.run.split('docker run')[1]);
    expect(gate.run).not.toMatch(
      /\|\|\s*true|--privileged|docker\.sock|--network host|:rw/,
    );
  });

  it('keeps six actual gateway state/health cases and exact failure/receipt checks in the Linux fixture', () => {
    expect(fixture).toContain('for FINALIZE_ATTEMPT in initial replay; do');
    expect(fixture).toContain('for FINALIZE_HEALTH_STATUS in 7 0; do');
    expect(fixture).toContain('FINALIZE_MARKERS_BEFORE=');
    expect(fixture).toContain(
      'gateway changed markers after failed finalization health',
    );
    expect(fixture).toContain(
      '[ "$FINALIZED_DEPLOYMENT" = "$EXPECTED_FINALIZED" ]',
    );
    expect(fixture).toContain('for ROLLED_FINALIZE_HEALTH_STATUS in 0 7; do');
    expect(fixture).toContain(
      'cannot finalize a rolled-back enterprise deployment',
    );
    expect(fixture).toContain(
      '[ ! -s "$TEST_ROOT/finalize-rolled-back.stdout" ]',
    );
    expect(fixture).toContain(
      'gateway changed a rolled-back transaction during finalization',
    );
  });
});
