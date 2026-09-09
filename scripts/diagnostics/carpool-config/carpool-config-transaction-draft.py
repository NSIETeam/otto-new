#!/usr/bin/env python3
"""PREPARE-ONLY draft. No apply, stop/start, live env replacement or DB writes.

The root operator must audit and hash-pin this file before any server execution.
This module's local tests never call prepare_on_host(). Receipts are not proof
of activation. A separately reviewed/exercised executor is deliberately absent.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

BOOTSTRAP = Path('/root/otto-gateway-bootstrap-1.9.15-20260909')
STAGING = BOOTSTRAP / 'carpool-configuration-preparation'
KEY_FILE = BOOTSTRAP / 'amap-shared-test-key'
PARK_EVIDENCE = BOOTSTRAP / 'verified-carpool-park.json'
CONFIG = Path('/etc/otto-enterprise/enterprise.env')
INSTALL = Path('/opt/otto-enterprise')
DEPLOY = INSTALL / 'deploy'
CURRENT = INSTALL / 'current'
NODE = INSTALL / 'runtime/current/bin/node'
PRODUCTION_LOCK = Path('/var/lib/otto-ci-deploy/locks/production.lock')
UPGRADE_LOCK = Path('/run/lock/otto-enterprise-deploy.lock')
SERVICE = 'otto-enterprise.service'
VERSION = '1.9.15'
FLAGS = tuple('OTTO_PARK_CARPOOL_' + name + '_ENABLED'
              for name in ('REQUESTS', 'INVITATIONS', 'GROUPS'))
MAP_KEY = 'OTTO_AMAP_WEB_SERVICE_KEY'
PARK_IDS = 'OTTO_PARK_CARPOOL_PILOT_PARK_IDS'
MUTABLE = frozenset((MAP_KEY, PARK_IDS, *FLAGS))
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
            'USER': 'root', 'LOGNAME': 'root', 'SHELL': '/bin/bash', 'LC_ALL': 'C'}


class Refusal(RuntimeError):
    """Only static, non-secret messages may be exposed."""


def need(condition, message):
    if not condition:
        raise Refusal(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_inputs(commit, park, phase):
    need(isinstance(commit, str) and re.fullmatch('[a-f0-9]{40}', commit), 'Full source commit required')
    need(isinstance(park, str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', park), 'One verified park ID required')
    need(phase in ('requests', 'groups'), 'Unsupported activation phase')


def phase_values(park, phase):
    return {FLAGS[0]: 'true', FLAGS[1]: str(phase == 'groups').lower(),
            FLAGS[2]: str(phase == 'groups').lower(), PARK_IDS: park}


def parse_env(data):
    need(isinstance(data, bytes) and len(data) <= 128 * 1024 and b'\0' not in data, 'Invalid environment bytes')
    try:
        lines = data.decode('utf-8').splitlines(keepends=True)
    except UnicodeError:
        raise Refusal('Environment must be UTF-8') from None
    values, rows = {}, []
    for raw in lines:
        line = raw.rstrip('\r\n').lstrip()
        if not line or line.startswith('#'):
            rows.append((None, raw))
            continue
        if line.startswith('export '):
            line = line[7:]
        need('=' in line, 'Malformed environment assignment')
        name, value = line.split('=', 1)
        name = name.rstrip()
        need(bool(re.fullmatch('[A-Z][A-Z0-9_]*', name)), 'Invalid environment key')
        need(name not in values, 'Duplicate environment key')
        if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        values[name] = value
        rows.append((name, raw))
    return values, rows


def candidate_environment(original, map_key_bytes, commit, park, phase):
    checked_inputs(commit, park, phase)
    values, rows = parse_env(original)
    need(values.get('OTTO_APP_VERSION') == VERSION, 'Existing configuration is not 1.9.15')
    proposed = phase_values(park, phase)
    for flag in FLAGS:
        old = values.get(flag, 'false')
        need(old in ('true', 'false', '1', '0'), 'Existing phase flag is invalid')
        need(not (old in ('true', '1') and proposed[flag] == 'false'), 'Activation must not downgrade an enabled phase')
    need(values.get(PARK_IDS) in (None, park), 'Existing pilot scope differs from verified single park')
    need(not original or original.endswith(b'\n'), 'Environment requires final newline for byte-preserving staging')
    try:
        map_key = map_key_bytes.decode('ascii').removesuffix('\n').removesuffix('\r')
    except (UnicodeError, AttributeError):
        raise Refusal('Invalid staged map key') from None
    need(bool(re.fullmatch('[a-fA-F0-9]{32}', map_key)), 'Invalid staged map key')
    replacements = {MAP_KEY: map_key, **phase_values(park, phase)}
    newline = '\r\n' if b'\r\n' in original else '\n'
    seen = set()
    output = []
    for name, raw in rows:
        if name in replacements:
            output.append(name + '="' + replacements[name] + '"' + newline)
            seen.add(name)
        else:
            output.append(raw)
    for name in sorted(set(replacements) - seen):
        output.append(name + '="' + replacements[name] + '"' + newline)
    candidate = ''.join(output).encode('utf-8')
    after, after_rows = parse_env(candidate)
    need({key: value for key, value in values.items() if key not in MUTABLE}
         == {key: value for key, value in after.items() if key not in MUTABLE}, 'Unrelated configuration changed')
    need([raw for name, raw in rows if name not in MUTABLE]
         == [raw for name, raw in after_rows if name not in MUTABLE], 'Unrelated bytes changed')
    return candidate


def validate_release(manifest, commit):
    need(manifest.get('format') == 'otto-enterprise-release-v1'
         and manifest.get('version') == VERSION
         and manifest.get('releaseChannel') == 'stable'
         and manifest.get('sourceCommit') == commit
         and manifest.get('sourceTreeDirty') is False,
         'Current release identity mismatch')
    build = manifest.get('buildCommit', '')
    need(bool(re.fullmatch('[a-f0-9]{40}', build)), 'Invalid release content build ID')
    need(manifest.get('database', {}).get('schemaTo') == 26, 'Expected schema 26 release')
    return build


def validate_park_evidence(evidence, commit, park, now):
    need(evidence.get('schema') == 'otto-operator-verified-park-v1'
         and evidence.get('sourceCommit') == commit and evidence.get('parkId') == park
         and evidence.get('exists') is True and evidence.get('active') is True,
         'Verified park evidence mismatch')
    stamp = evidence.get('verifiedAtUnix')
    need(isinstance(stamp, int) and not isinstance(stamp, bool)
         and 0 <= now - stamp <= 900, 'Verified park evidence is stale')
    need(bool(re.fullmatch('[a-f0-9]{64}', evidence.get('evidenceSha256', ''))),
         'Verified park evidence needs a retained source receipt digest')


def validate_strict_summary(summary, manifest):
    need(summary.get('ok') is True and all(summary.get(name) == manifest.get(name)
         for name in ('version', 'releaseChannel', 'buildCommit', 'sourceCommit', 'database')),
         'Strict release verification disagrees')


def validate_stop_evidence(evidence, compensation=False):
    """Pure future-executor contract; does not stop or inspect a real service."""
    need(evidence.get('stopCommandSucceeded') is True, 'Stop failed or timed out')
    need(evidence.get('LoadState') == 'loaded'
         and evidence.get('FragmentPath') == '/etc/systemd/system/otto-enterprise.service',
         'Unknown managed service identity')
    allowed = ('inactive', 'failed') if compensation else ('inactive',)
    need(evidence.get('ActiveState') in allowed and evidence.get('MainPID') == '0', 'Service not proven stopped')
    need(evidence.get('ControlGroup') in ('', '/system.slice/otto-enterprise.service')
         and evidence.get('cgroupV2') is True and evidence.get('cgroupEmpty') is True
         and type(evidence.get('descendantPopulated')) is int
         and evidence.get('descendantPopulated') == 0, 'Service cgroup not proven empty')
    if not compensation:
        need(evidence.get('Result') == 'success' and evidence.get('ExecMainStatus') == '0',
             'Healthy old service did not drain cleanly')
    return True


def root_directory(path, sticky_lock_dir=False):
    for item in (path, *path.parents):
        info = item.lstat()
        permitted_sticky = sticky_lock_dir and item == Path('/run/lock') and bool(info.st_mode & stat.S_ISVTX)
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
             and (not info.st_mode & 0o022 or permitted_sticky), 'Directory custody mismatch')


def trusted_file(path, private=False):
    root_directory(path.parent)
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0
         and info.st_gid == 0 and not info.st_mode & 0o022, 'File custody mismatch')
    if private:
        need(stat.S_IMODE(info.st_mode) == 0o600, 'Private file must be root 0600')
    return info


def read_trusted(path, private=False, limit=128 * 1024):
    before = trusted_file(path, private)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(fd)
        need((actual.st_dev, actual.st_ino) == (before.st_dev, before.st_ino), 'File changed during open')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        need(len(data) <= limit, 'Input exceeds bounded size')
        return data
    finally:
        os.close(fd)


def json_object(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'Duplicate JSON property')
            result[key] = value
        return result
    try:
        result = json.loads(data, object_pairs_hook=unique)
        need(isinstance(result, dict), 'JSON object required')
        return result
    except (ValueError, UnicodeError):
        raise Refusal('Invalid JSON') from None


@contextmanager
def locked(path):
    import fcntl  # Linux outer only; pure local tests do not import it.
    root_directory(path.parent, sticky_lock_dir=path == UPGRADE_LOCK)
    if path == PRODUCTION_LOCK:
        need(stat.S_IMODE(path.parent.lstat().st_mode) == 0o700, 'Production lock directory custody mismatch')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        current = path.lstat()
        need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0
             and info.st_gid == 0 and not info.st_mode & 0o022
             and (info.st_dev, info.st_ino) == (current.st_dev, current.st_ino), 'Unsafe shared lock inode')
        if path == PRODUCTION_LOCK:
            need(stat.S_IMODE(info.st_mode) == 0o600, 'Production lock custody mismatch')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal('Deployment or configuration lock is busy') from None
        yield
    finally:
        os.close(fd)


def durable_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def durable_directory(path):
    path.mkdir(mode=0o700)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def run(argv, timeout=45):
    try:
        result = subprocess.run([str(part) for part in argv], env=SAFE_ENV, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Refusal('Bounded verification command failed') from None
    need(result.returncode == 0 and len(result.stdout) <= 4 * 1024 * 1024,
         'Verification command rejected staged configuration')
    return result.stdout  # Never include raw stdout/stderr in exceptions or receipt.


RUNTIME_PROBE = """
const {pathToFileURL}=await import('node:url');
const {readCarpoolConfig,carpoolCommunicationCapabilities}=await import(pathToFileURL(process.argv[1]).href);
const c=readCarpoolConfig(process.env);const phase=process.argv[2],park=process.argv[3];
if(c.requestsEnabled!==true||c.invitationsEnabled!==(phase==='groups')||c.groupsEnabled!==(phase==='groups')||JSON.stringify(c.pilotParkIds)!==JSON.stringify([park]))throw Error('phase mismatch');
const expected=phase==='groups'?4:2;if(carpoolCommunicationCapabilities(c,park).length!==expected||carpoolCommunicationCapabilities(c,park+'__outside').length!==0)throw Error('pilot scope mismatch');
process.stdout.write(JSON.stringify({ok:true,phase,parkId:park,pilotCount:1}));
"""


def prepare_on_host(commit, park, phase):
    checked_inputs(commit, park, phase)
    need(sys.platform == 'linux' and os.geteuid() == 0, 'Linux root prepare-only mode required')
    os.umask(0o077)
    # Lock order is deliberately the same as gateway -> oneclick upgrade.
    with locked(PRODUCTION_LOCK), locked(UPGRADE_LOCK):
        root_directory(BOOTSTRAP)
        root_directory(INSTALL / 'releases')
        pointer = CURRENT.lstat()
        need(stat.S_ISLNK(pointer.st_mode) and pointer.st_uid == 0 and pointer.st_gid == 0,
             'Managed current pointer custody mismatch')
        raw_target = Path(os.readlink(CURRENT))
        target = raw_target if raw_target.is_absolute() else CURRENT.parent / raw_target
        need(target.parent == INSTALL / 'releases', 'Current release escapes canonical directory')
        root_directory(target)
        need(target.resolve(strict=True) == target, 'Nested current release alias refused')
        root_directory(INSTALL / 'runtime')
        runtime_pointer = INSTALL / 'runtime/current'
        runtime_info = runtime_pointer.lstat()
        need(stat.S_ISLNK(runtime_info.st_mode) and runtime_info.st_uid == 0 and runtime_info.st_gid == 0,
             'Managed runtime pointer custody mismatch')
        runtime_raw = Path(os.readlink(runtime_pointer))
        runtime = runtime_raw if runtime_raw.is_absolute() else runtime_pointer.parent / runtime_raw
        root_directory(runtime)
        need(runtime.resolve(strict=True) == runtime, 'Nested runtime alias refused')
        node = runtime / 'bin/node'
        trusted_file(node)
        for relative in ('lib/common.sh', 'tools/verify-release.mjs', 'tools/health-check.mjs'):
            trusted_file(DEPLOY / relative)
        manifest_bytes = read_trusted(target / 'manifest.json', limit=4 * 1024 * 1024)
        manifest = json_object(manifest_bytes)
        build = validate_release(manifest, commit)
        need(target.name == VERSION + '-' + build[:12], 'Canonical release directory identity mismatch')
        strict = json_object(run([node, '--max-old-space-size=256', DEPLOY / 'tools/verify-release.mjs', target]))
        validate_strict_summary(strict, manifest)
        need(run([node, '--version']).strip() == b'v22.23.1', 'Fixed Node runtime mismatch')
        original = read_trusted(CONFIG, private=True)
        values, _ = parse_env(original)
        need(values.get('OTTO_BUILD_COMMIT') == build, 'Configured runtime content build differs')
        park_evidence_bytes = read_trusted(PARK_EVIDENCE, private=True)
        evidence = json_object(park_evidence_bytes)
        validate_park_evidence(evidence, commit, park, int(time.time()))
        key = read_trusted(KEY_FILE, private=True, limit=64)
        candidate = candidate_environment(original, key, commit, park, phase)
        if not STAGING.exists():
            durable_directory(STAGING)
        root_directory(STAGING)
        need(stat.S_IMODE(STAGING.lstat().st_mode) == 0o700, 'Staging directory must be private')
        txn = STAGING / (commit[:12] + '-' + phase + '-' + digest(park.encode())[:12])
        need(not txn.exists() and not txn.is_symlink(), 'Existing transaction: preserve evidence; no blind replay')
        durable_directory(txn)
        durable_file(txn / 'intent.json', json.dumps({'mode': 'prepare-only', 'sourceCommit': commit,
                     'parkId': park, 'phase': phase, 'activationSupported': False}).encode())
        try:
            durable_file(txn / 'old.env', original)
            durable_file(txn / 'candidate.env', candidate)
            # Trusted common reads literal values, never eval/source the secret env.
            shell = 'set -Eeuo pipefail; source "$1"; otto_load_config "$2"; shift 2; exec "$@"'
            common = DEPLOY / 'lib/common.sh'
            run(['/bin/bash', '-c', shell, 'otto-config-prepare', common, txn / 'candidate.env',
                 node, '--input-type=module', '-e', RUNTIME_PROBE,
                 target / 'src/modules/park_carpool/parkCarpoolConfig.js', phase, park])
            # Existing runtime health uses OLD configuration. Candidate is never launched.
            allow = 'allow-sms-disabled' if values.get('OTTO_ALLOW_SMS_DISABLED') == '1' else 'require-sms'
            health = json_object(run(['/bin/bash', '-c', shell, 'otto-config-prepare', common, CONFIG,
                node, DEPLOY / 'tools/health-check.mjs', 'http://127.0.0.1:7778', VERSION, build, '26', allow]))
            need(health.get('ok') is True, 'Current runtime health did not pass')
            state = run(['/usr/bin/systemctl', 'show', SERVICE, '--property=LoadState', '--property=ActiveState',
                         '--property=MainPID', '--property=FragmentPath']).decode()
            required = ('LoadState=loaded', 'ActiveState=active', 'FragmentPath=/etc/systemd/system/otto-enterprise.service')
            need(all(line in state.splitlines() for line in required)
                 and re.search(r'^MainPID=[1-9][0-9]*$', state, re.M), 'Current managed service is not healthy active')
            need(CURRENT.resolve(strict=True) == target and read_trusted(CONFIG, private=True) == original
                 and read_trusted(target / 'manifest.json', limit=4 * 1024 * 1024) == manifest_bytes,
                 'Deployment changed during preflight')
            result = {'schema': 'otto-carpool-config-prepare-v1', 'preparedOnly': True, 'activated': False,
                'sourceCommit': commit, 'runtimeBuildCommit': build, 'version': VERSION, 'schemaVersion': 26,
                'parkId': park, 'phase': phase, 'changedKeys': sorted(MUTABLE),
                'oldEnvironmentSha256': digest(original), 'candidateEnvironmentSha256': digest(candidate),
                'manifestSha256': digest(manifest_bytes), 'parkEvidenceSha256': digest(park_evidence_bytes),
                'currentHealthPassed': True, 'newRuntimeConfigParserPassed': True,
                'liveEnvironmentReplaced': False, 'serviceStoppedOrStarted': False,
                'activationExecutorImplemented': False, 'completedAtUnix': int(time.time())}
            durable_file(txn / 'prepared.json', json.dumps(result, indent=2).encode())
            return result
        except Exception:
            durable_file(txn / 'preparation-failed.json', b'{"preparedOnly":true,"activated":false,"retainEvidence":true}')
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', required=True)
    parser.add_argument('--expected-commit', required=True)
    parser.add_argument('--verified-park-id', required=True)
    parser.add_argument('--phase', required=True, choices=('requests', 'groups'))
    args = parser.parse_args()
    result = prepare_on_host(args.expected_commit, args.verified_park_id, args.phase)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Refusal as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except Exception:
        print('Preparation failed; preserve private transaction evidence', file=sys.stderr)
        sys.exit(2)
