/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const upgrade = readFileSync(path.join(root, 'deployment/enterprise-oneclick/upgrade.sh'), 'utf8').replaceAll('\r\n', '\n');
const cleanup = upgrade.slice(upgrade.indexOf('cleanup() {'), upgrade.indexOf('\ntrap cleanup EXIT'));
const helperStart = upgrade.indexOf('otto_read_compensation_service_state() {');
const helpers = helperStart < 0 ? '' : upgrade.slice(helperStart, upgrade.indexOf('cleanup() {'));
const git = process.platform === 'win32'
  ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
  : null;
const bash = git ? path.resolve(path.dirname(git), '../bin/bash.exe') : 'bash';

function runCompensation({ state = 'inactive', pid = '0', cgroup = '', stopStatus = 0,
  populated = '0', mainProcesses = '', showStatus = 0, missingPid = false,
  duplicatePid = false, missingEvents = false, realChild = false, failedCandidate = false,
  existingMarker = false, stateChanges = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'otto-compensation-'));
  try {
    mkdirSync(path.join(directory, 'txn/deploy.before'), { recursive: true });
    mkdirSync(path.join(directory, 'install/deploy'), { recursive: true });
    mkdirSync(path.join(directory, 'data'));
    mkdirSync(path.join(directory, 'cgroup/system.slice/otto-enterprise.service'), { recursive: true });
    for (const file of ['data.db.before', 'enterprise.env.before', 'otto-enterprise.service.before', 'resident-recurring-tasks.absent']) {
      writeFileSync(path.join(directory, 'txn', file), 'snapshot');
    }
    writeFileSync(path.join(directory, 'install/deploy/verify.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(path.join(directory, 'cgroup/cgroup.controllers'), 'cpu memory\n');
    writeFileSync(path.join(directory, 'cgroup/system.slice/otto-enterprise.service/cgroup.procs'), mainProcesses);
    if (!missingEvents) writeFileSync(path.join(directory, 'cgroup/system.slice/otto-enterprise.service/cgroup.events'), `populated ${populated}\nfrozen 0\n`);
    if (existingMarker) writeFileSync(path.join(directory, 'txn/recovery-required'), 'original-evidence\n');
    const script = `set -Eeuo pipefail
cd -- "$FIXTURE_DIRECTORY"
CGROUP_FIXTURE="$PWD/cgroup"
TXN_DIR="$PWD/txn"
INSTALL_ROOT="$PWD/install"
DATA_DIR="$PWD/data"
OLD_DATA_BACKUP="$TXN_DIR/data.db.before"
CONFIG_BACKUP="$TXN_DIR/enterprise.env.before"
SERVICE_UNIT_BACKUP="$TXN_DIR/otto-enterprise.service.before"
OLD_RESIDENT_STATE_BACKUP="$TXN_DIR/resident-recurring-tasks.json.before"
OLD_RESIDENT_STATE_ABSENT="$TXN_DIR/resident-recurring-tasks.absent"
RESIDENT_STATE_PATH="$DATA_DIR/resident-recurring-tasks.json"
OLD_DEPLOY_BACKUP="$TXN_DIR/deploy.before"
CURRENT_REAL="$PWD/old-release"
CONFIG_PATH="$PWD/enterprise.env"
SERVICE_UNIT="$PWD/service"
MANAGED_DATABASE_KEY_PATH="$PWD/managed.key"
CANARY_PID=''
TARGET_RELEASE_STAGE=''
ROLLBACK_DIR="$TXN_DIR"
ROLLBACK_WITNESS_FILE="$TXN_DIR/witness"
DRY_RUN=0
ROLLBACK_NEEDED=1
UPGRADE_SUCCEEDED=0
SERVICE_STOPPED=1
RESIDENT_STATE_EXISTED=0
DATABASE_KEY_CREATED=1
OTTO_ALLOW_SMS_DISABLED=0
printf candidate-key > "$MANAGED_DATABASE_KEY_PATH"
mutation() { printf 'MUTATION %s\n' "$*" >> "$TXN_DIR/calls"; }
install() { mutation "install $*"; }
ln() { mutation "ln $*"; }
mv() { mutation "mv $*"; }
cp() { mutation "cp $*"; }
rm() { mutation "rm $*"; }
systemctl() {
  case "$1" in
    stop) printf 'stop\n' >> "$TXN_DIR/stop-calls"; return ${stopStatus} ;;
    show)
      printf 'show\n' >> "$TXN_DIR/show-calls"
      ${showStatus ? `return ${showStatus}` : ''}
      observed_state=${JSON.stringify(state)}
      if [ ${stateChanges ? 'true' : 'false'} = true ] && [ "$(wc -l < "$TXN_DIR/show-calls")" -ge 3 ]; then observed_state=active; fi
      printf 'ActiveState=%s\n' "$observed_state"
      ${missingPid ? '' : `printf 'MainPID=%s\\n' ${JSON.stringify(pid)}`}
      ${duplicatePid ? "printf 'MainPID=0\\n'" : ''}
      printf 'ControlGroup=%s\n' ${JSON.stringify(cgroup)}
      ;;
    start|daemon-reload) mutation "systemctl $*" ;;
    *) return 99 ;;
  esac
}
timeout() {
  printf '%s\n' "$*" >> "$TXN_DIR/timeouts"
  while [ "$#" -gt 0 ]; do case "$1" in --*) shift ;; *) shift; break ;; esac; done
  "$@"
}
stat() { if [ "$1" = -f ]; then printf 'cgroup2fs\n'; else command stat "$@"; fi; }
otto_warn() { printf '%s\n' "$*" >&2; }
otto_log() { printf '%s\n' "$*"; }
sync_live_deployment_filesystems() { mutation sync; }
write_rollback_verified_witness() { mutation witness; }
fixture_sync() { :; }
${realChild ? `sleep 2 &
protected_pid=$!
trap 'kill "$protected_pid" 2>/dev/null || :; wait "$protected_pid" 2>/dev/null || :' EXIT
printf '%s\\n' "$protected_pid" > "$CGROUP_FIXTURE/system.slice/otto-enterprise.service/cgroup.procs"
printf 'populated 1\\nfrozen 0\\n' > "$CGROUP_FIXTURE/system.slice/otto-enterprise.service/cgroup.events"
kill -0 "$protected_pid"` : ''}
${failedCandidate ? `(exit 7) &
candidate_pid=$!
if wait "$candidate_pid"; then exit 99; else candidate_status=$?; fi
[ "$candidate_status" -eq 7 ]
if kill -0 "$candidate_pid" 2>/dev/null; then exit 98; fi` : ''}
${helpers.replaceAll("'/sys/fs/cgroup/system.slice/otto-enterprise.service'", '"$CGROUP_FIXTURE/system.slice/otto-enterprise.service"').replaceAll('/sys/fs/cgroup', '$CGROUP_FIXTURE')}
${cleanup.replaceAll('/usr/bin/sync', 'fixture_sync')}
cleanup
`;
    const result = spawnSync(bash, [], {
      input: script, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, FIXTURE_DIRECTORY: directory.replaceAll('\\', '/') },
    });
    const read = (file) => existsSync(path.join(directory, 'txn', file))
      ? readFileSync(path.join(directory, 'txn', file), 'utf8') : '';
    return { ...result, calls: read('calls'), marker: read('recovery-required'), timeouts: read('timeouts') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('upgrade compensation requires a stopped service before restoring bytes', () => {
  it('restores a stopped candidate even when its actual process exited nonzero', () => {
    const result = runCompensation({ state: 'failed', failedCandidate: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain('data.db.before');
    expect(result.calls).toContain('systemctl start');
    expect(result.calls).toContain('witness');
    expect(result.marker).toBe('');
  });

  it.each([
    ['active service', { state: 'active', pid: '123' }],
    ['active without main pid', { state: 'active' }],
    ['unknown main pid', { pid: 'unknown' }],
    ['missing main pid', { missingPid: true }],
    ['duplicate main pid', { duplicatePid: true }],
    ['nonzero main pid after stop', { pid: '123' }],
    ['systemctl show error', { showStatus: 1 }],
    ['stop timeout', { stopStatus: 124 }],
    ['stop killed after timeout', { stopStatus: 137 }],
    ['stop error', { stopStatus: 1 }],
    ['populated descendant cgroup', { populated: '1' }],
    ['main cgroup still has pid', { mainProcesses: '123\n' }],
    ['missing cgroup events', { missingEvents: true }],
    ['unknown cgroup contents', { populated: 'unknown' }],
    ['unexpected cgroup path', { cgroup: '/untrusted.slice/elsewhere.service' }],
    ['reactivation during proof', { stateChanges: true }],
  ])('blocks every restore mutation when %s', (_label, scenario) => {
    const result = runCompensation(scenario);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.calls).toBe('');
    expect(result.stderr).toContain('recovery-required');
    expect(result.marker).toContain('otto-enterprise-upgrade-recovery-required-v1');
  });

  it('rejects a live controlled child even when systemd reports failed with MainPID=0', () => {
    const result = runCompensation({ state: 'failed', realChild: true });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.calls).toBe('');
    expect(result.marker).toContain('recovery-required');
  });

  it('preserves a pre-existing recovery marker instead of overwriting evidence', () => {
    const result = runCompensation({ stopStatus: 124, existingMarker: true });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.calls).toBe('');
    expect(result.marker).toBe('original-evidence\n');
  });

  it('bounds systemctl stop outside the existing 60-second service stop window', () => {
    const result = runCompensation();
    expect(result.status, result.stderr).toBe(0);
    expect(result.timeouts).toContain('--signal=TERM --kill-after=5s 75s systemctl stop otto-enterprise');
    expect(upgrade).toContain('GRACEFUL_RESULT');
    expect(upgrade).toContain('[ "$GRACEFUL_MAIN_STATUS" = 0 ]');
  });
});
