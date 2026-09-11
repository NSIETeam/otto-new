/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const load = name => parse(readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const release = load('release.yml');
const deployment = load('deploy-server.yml');
const principals = deployment.jobs['validate-deployment-principals'];
const check = principals.steps.find(step => step.name === 'Prove distinct keys and server-side account isolation');
const git = process.platform === 'win32'
  ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
  : null;
const bash = git ? path.resolve(path.dirname(git), '../bin/bash.exe') : 'bash';
const fixture = {
  DEPLOY_HOST: 'fixture.invalid',
  DEPLOY_USER: 'fixture_deploy',
  ROLLBACK_DEPLOY_USER: 'fixture_rollback',
  DEPLOY_PORT: '22',
  DEPLOY_SSH_KEY: 'FAKE_PRIVATE_DEPLOY\nnot-a-key',
  ROLLBACK_DEPLOY_SSH_KEY: 'FAKE_PRIVATE_ROLLBACK\nnot-a-key',
  DEPLOY_KNOWN_HOSTS: 'FAKE_KNOWN_HOSTS',
};

// Only run the actual pre-materialization checks. No private-key files, SSH,
// GitHub or production calls; this is not a hosted secret-resolution test.
function exercise(overrides = {}, absent = []) {
  const end = check.run.indexOf('PRINCIPAL_AUDIT_DIR=');
  expect(end).toBeGreaterThan(0);
  const script = check.run.slice(0, end);
  expect(script).not.toMatch(/\b(?:ssh|ssh-keygen|mktemp|curl|gh)\b/);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...fixture, ...overrides };
  for (const key of absent) delete env[key];
  return spawnSync(bash, ['--noprofile', '--norc'], {
    input: `${script}\nprintf 'configuration-present\\n'\n`,
    encoding: 'utf8', timeout: 5000, env,
  });
}

describe('enterprise reusable deployment secret boundary', () => {
  it('explicitly inherits secrets only into the same-commit local deployment workflow', () => {
    const call = release.jobs['deploy-enterprise'];
    expect(call.uses).toBe('./.github/workflows/deploy-server.yml');
    expect(call.secrets).toBe('inherit');
    expect(call.environment).toBeUndefined();
    expect(call.permissions).toEqual({ contents: 'read' });
    expect(call.needs).toEqual(['build', 'verify-windows-signature', 'create-release-drafts', 'validate-deployment-principals']);
    expect(call.if).toContain('success()');
    expect(call.if).toContain('!inputs.draft');
    expect(call.with.use_workflow_artifact).toBe(true);
    expect(call.with.defer_finalize).toBe(true);
    expect(call['continue-on-error']).toBeUndefined();
    expect(Object.values(deployment.jobs).some(job => job.uses)).toBe(false);
  });

  it('keeps environment protection and both principal checks mandatory', () => {
    expect(release.jobs['validate-deployment-principals'].environment).toBe('production-automation');
    expect(principals.environment).toBe('production-automation');
    expect(principals.permissions).toEqual({});
    expect(principals['continue-on-error']).toBeUndefined();
    expect(check['continue-on-error']).toBeUndefined();
    expect(check.if).toBeUndefined();
    expect(deployment.jobs['manual-production-approval'].environment).toBe('production-approval');
    expect(deployment.jobs.deploy.environment).toBe('production-automation');
    expect(deployment.jobs.deploy.needs).toContain('validate-deployment-principals');
    expect(deployment.jobs.deploy.if).toContain("needs.validate-deployment-principals.result == 'success'");
    for (const name of Object.keys(fixture)) {
      expect(check.env[name]).toBe(name === 'DEPLOY_PORT'
        ? "${{ secrets.DEPLOY_PORT || '22' }}" : '${{ secrets.' + name + ' }}');
    }
    const original = release.jobs['validate-deployment-principals'].steps[0].run;
    expect(check.run).toBe(original);
  });

  it.each(Object.keys(fixture))('rejects empty %s with its name but no configuration values', name => {
    const result = exercise({ [name]: '' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(`::error::Missing required deployment configuration: ${name} (production-automation).`);
    for (const value of Object.values(fixture)) expect(result.stderr).not.toContain(value);
  });

  it.each(Object.keys(fixture))('rejects unset %s without a nounset crash or value disclosure', name => {
    const result = exercise({}, [name]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(`::error::Missing required deployment configuration: ${name} (production-automation).`);
  });

  it('accepts present fixture configuration without printing values or running any network calls', () => {
    const result = exercise();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('configuration-present\n');
    expect(result.stderr).toBe('');
  });

  it.each([
    { DEPLOY_HOST: '-invalid' }, { DEPLOY_HOST: 'invalid..host' },
    { DEPLOY_USER: 'root;true' }, { ROLLBACK_DEPLOY_USER: 'root;true' },
    { ROLLBACK_DEPLOY_USER: fixture.DEPLOY_USER },
    { DEPLOY_PORT: '0' }, { DEPLOY_PORT: '65536' }, { DEPLOY_PORT: '22;true' },
  ])('does not replace the existing grammar and distinct-principal validation: %j', invalid => {
    const result = exercise(invalid);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
