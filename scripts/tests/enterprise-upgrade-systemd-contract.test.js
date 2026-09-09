/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const harnessPath = path.join(root, 'scripts/tests/enterprise-upgrade-systemd-integration.py');
const harness = readFileSync(harnessPath, 'utf8');
const workerHarness = readFileSync(path.join(root, 'scripts/tests/enterprise-canary-systemd-integration.py'), 'utf8');
const workflow = readFileSync(path.join(root, '.github/workflows/enterprise-upgrade-systemd.yml'), 'utf8');
const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const python = process.platform === 'win32' ? 'python' : 'python3';
const validator = `import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('acceptance',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
data=json.load(sys.stdin)
try:
    result=module.restoration_arguments(pathlib.Path(data['fixture']),data['command'],data['args'])
    print(json.dumps({'accepted':True,'args':result}))
except RuntimeError:
    print(json.dumps({'accepted':False}))
`;

function checkArguments(command, makeArguments, { linkOutside = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'otto-systemd-validator-'));
  try {
    const fixture = path.join(directory, 'fixture');
    const outside = path.join(directory, 'outside');
    mkdirSync(fixture);
    mkdirSync(outside);
    if (linkOutside) symlinkSync(outside, path.join(fixture, 'escape'), 'junction');
    const result = spawnSync(python, ['-I', '-S', '-B', '-c', validator, harnessPath], {
      encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ fixture, command, args: makeArguments(fixture, outside) }),
    });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('disposable real-systemd workflow boundary (not a Linux acceptance substitute)', () => {
  it('uses only this checkout, read permission, a hosted runner and bounded runtime', () => {
    expect(workflow).toContain('workflow_call:');
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('timeout-minutes: 8');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toMatch(/secrets\.|secrets:|id-token:|contents: write|environment:|pull_request_target|repository:/);
    expect(workflow).not.toMatch(/\b(?:apt(?:-get)?|npm|pip) (?:install|ci)|\bcurl\b|\bwget\b/);
    expect(workflow.match(/^\s*uses: .+$/gm)).toHaveLength(5);
    for (const line of workflow.match(/^\s*uses: .+$/gm)) expect(line).toMatch(/@[a-f0-9]{40}\b/);
  });

  it('runs the real worker harness on a separate bounded host with no npm install', () => {
    const worker = workflow.slice(workflow.indexOf('\n  canary-worker-systemd:'));
    expect(worker).toContain('runs-on: ubuntu-24.04');
    expect(worker).toContain('timeout-minutes: 12');
    expect(worker).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(worker).toContain("node-version: '22.23.1'");
    expect(worker).toContain('test "$(git rev-parse HEAD)" = "$TEST_COMMIT"');
    expect(worker).toContain('enterprise-canary-systemd-integration.py');
    expect(worker).toContain('--evidence-dir "$evidence"');
    expect(worker).toContain('OTTO_CANARY_TEST_NODE="$node_path"');
    expect(worker).not.toContain('cache:');
    expect(worker).not.toContain('continue-on-error:');
    expect(workerHarness).toContain("'canary account must not pre-exist in disposable runner'");
    expect(workerHarness).toContain("'canary group must not pre-exist in disposable runner'");
    expect(workerHarness).toContain('os.fchown(fd,evidence_owner.st_uid,evidence_owner.st_gid)');
    expect(workerHarness).toContain("report['passed'] = False");
  });

  it('uses a clean environment and network namespace and keeps failure evidence', () => {
    expect(workflow).toContain('sudo -n unshare --net -- /usr/bin/env -i');
    expect(workflow).toContain('OTTO_DISPOSABLE_SYSTEMD_ACCEPTANCE=1');
    expect(workflow).toContain('preflight-not-completed');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('if-no-files-found: error');
    expect(workflow).toContain('retention-days: 14');
  });

  it('makes real systemd acceptance mandatory before signing/build/publication', () => {
    const gate = release.slice(release.indexOf('\n  enterprise-upgrade-systemd:'), release.indexOf('\n  sqlcipher-native:'));
    expect(gate).toContain('needs: validate-source');
    expect(gate).toContain('uses: ./.github/workflows/enterprise-upgrade-systemd.yml');
    expect(gate).toContain('contents: read');
    expect(gate).not.toMatch(/secrets:|with:|if:/);
    const build = release.slice(release.indexOf('\n  build:'), release.indexOf('\n  verify-windows-signature:'));
    expect(build).toMatch(/needs:\s*\n(?:\s+- [^\n]+\n)*\s+- enterprise-upgrade-systemd\b/);
    expect(build).not.toContain('continue-on-error:');
  });

  it('refuses ordinary host execution before any unit or fixture operation', () => {
    const result = spawnSync(python, ['-I', '-S', harnessPath], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, OTTO_DISPOSABLE_SYSTEMD_ACCEPTANCE: '', GITHUB_ACTIONS: '' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Linux root required|refusing outside explicit disposable/);
  });

  it('extracts the actual guard and cleanup without replacing systemctl/cgroup evidence', () => {
    expect(harness).toContain('source.index("otto_read_compensation_service_state() {")');
    expect(harness).toContain('source.index("\\ntrap cleanup EXIT", start)');
    expect(harness).toContain('self.logic = source[start:end]');
    expect(harness).not.toMatch(/self\.logic\.replace|def fake_|cgroup_fixture|timeout\(\)\s*\{/);
    expect(harness).toContain('"/usr/bin/systemctl", "show", UNIT');
    expect(harness).toContain('(CGROUP / "cgroup.events").read_text()');
    expect(harness).toContain('(CGROUP / "cgroup.procs").read_text()');
    expect(harness).toContain('acceptance.exercise("unknown-unit")');
    expect(harness).toContain('75 <= receipt["seconds"] < 100');
  });

  it('limits effects to an absent managed test unit and ledger-bound restoration fixtures', () => {
    expect(harness).toContain('"pre-existing service identity; refusing"');
    expect(harness).toContain('"existing service or production path; refusing"');
    expect(harness).toContain('with UNIT_FILE.open("x")');
    expect(harness).toContain('digest(UNIT_FILE) == self.unit_digest');
    expect(harness).toContain('state().get("FragmentPath") == str(UNIT_FILE)');
    expect(harness).toContain('"fixture ownership changed"');
    expect(harness).toContain('"restoration began before stop proof"');
    expect(harness).toContain('"cleanupPassed"');
    expect(harness).not.toMatch(/\["[^"\n]+", "(?:reboot|poweroff|restart)"/);
    expect(harness).toContain('MemoryMax=64M');
    expect(harness).toContain('PrivateNetwork=yes');
  });
});

describe('actual restoration operand validator', () => {
  it.each([
    ['install', (f) => ['-o', 'otto-enterprise', '-g', 'otto-enterprise', '-m', '0600', path.join(f, 'before'), path.join(f, 'data')]],
    ['ln', (f) => ['-sfn', path.join(f, 'old'), path.join(f, 'current')]],
    ['mv', (f) => ['-Tf', path.join(f, 'next'), path.join(f, 'current')]],
    ['mv', (f) => [path.join(f, 'before'), path.join(f, 'deploy')]],
    ['cp', (f) => ['-a', path.join(f, 'before'), path.join(f, 'deploy')]],
    ['rm', (f) => ['-rf', path.join(f, 'deploy')]],
  ])('accepts only bounded cleanup grammar: %s', (command, args) => {
    expect(checkArguments(command, args).accepted).toBe(true);
  });

  it.each([
    ['rm', (f, outside) => ['-rf', outside]],
    ['rm', (f) => ['-rf', f]],
    ['rm', () => ['-rf', '../escape']],
    ['cp', (f) => ['--target-directory=/etc', path.join(f, 'before'), path.join(f, 'after')]],
    ['install', (f) => ['-o', 'root', '-g', 'root', '-m', '0777', path.join(f, 'before'), path.join(f, 'after')]],
    ['install', (f) => ['-o', 'root', '-g', 'root', '-m', '0600', path.join(f, 'before'), '/etc/enterprise.env']],
    ['reboot', () => []],
  ])('rejects escaped or broadened command: %s', (command, args) => {
    expect(checkArguments(command, args).accepted).toBe(false);
  });

  it('rejects an apparently in-fixture operand whose ancestor is an external link', () => {
    expect(checkArguments('rm', (f) => ['-rf', path.join(f, 'escape/child')], { linkOutside: true }).accepted).toBe(false);
  });
});
