#!/usr/bin/env python3
"""Local-review candidate: bounded 1.9.15 configuration transaction, not deployment.

No production execution has been performed to develop this file. There is no
resume/retry/reboot command. A production call requires fresh root-held release
acceptance and separately preserved 1.9.14 recovery identities. Test adapters
exercise this same transaction engine without production paths or credentials.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import time

DRAFT_SHA = '8c954109ddae2e08417b0cec4f95bcf43dc4555ffa318f88790224a9da050ddf'
DRAFT = Path(__file__).with_name('carpool-config-transaction-draft.py')
if hashlib.sha256(DRAFT.read_bytes()).hexdigest() != DRAFT_SHA:
    raise SystemExit('Frozen preparation primitives changed; review required')
spec = importlib.util.spec_from_file_location('otto_config_primitives', DRAFT)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def trusted_read(path, private=False, limit=128 * 1024):
    before = p.trusted_file(path, private)
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mode, info.st_uid,
                info.st_gid, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)
    p.need(before.st_size <= limit, 'Trusted input exceeds bounded size')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        p.need(identity(os.fstat(fd)) == identity(before), 'Trusted input changed during open')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        p.need(len(data) <= limit and identity(os.fstat(fd)) == identity(before)
               and identity(path.lstat()) == identity(before), 'Trusted input changed during read')
        return data
    finally:
        os.close(fd)


def bounded_run(argv, timeout=45):
    """Bound both pipes while running; timeout never echoes command or output."""
    p.need(0 < timeout <= 80, 'Invalid bounded command deadline')
    overflow = threading.Event()
    output = [bytearray(), bytearray()]
    process = subprocess.Popen([str(item) for item in argv], env=p.SAFE_ENV,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True)
    def drain(index, pipe):
        try:
            while True:
                chunk = pipe.read(4096)
                if not chunk:
                    break
                if len(output[index]) + len(chunk) > 1024 * 1024:
                    overflow.set()
                    break
                output[index].extend(chunk)
        finally:
            pipe.close()
    threads = [threading.Thread(target=drain, args=(index, pipe), daemon=True)
               for index, pipe in enumerate((process.stdout, process.stderr))]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None:
            p.need(not overflow.is_set(), 'Bounded command output limit exceeded')
            remaining = deadline - time.monotonic()
            p.need(remaining > 0, 'Bounded command deadline exceeded')
            overflow.wait(min(0.02, remaining))
        for thread in threads:
            thread.join(max(0, deadline - time.monotonic()))
        p.need(not any(thread.is_alive() for thread in threads) and not overflow.is_set()
               and process.returncode == 0, 'Bounded command failed')
        return bytes(output[0])
    finally:
        # Kill only this helper's fresh process group, never the managed service.
        # An uncertain systemctl stop result is left for recovery reconciliation.
        if process.poll() is None or any(thread.is_alive() for thread in threads):
            if sys.platform == 'linux':
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        for thread in threads:
            thread.join(0.1)


# Keep the frozen file unchanged. Every host call (including its lock-adjacent
# helpers) uses hardened replacements in this private imported module instance.
p.read_trusted = trusted_read
p.run = bounded_run

BOOTSTRAP = p.BOOTSTRAP
ACCEPTANCE = BOOTSTRAP / 'carpool-activation-acceptance.json'
STAGING = BOOTSTRAP / 'carpool-configuration-transactions'
RECOVERY_ENV = BOOTSTRAP / 'carpool-recovery-1.9.14.env'
RECOVERY_DEPLOY = BOOTSTRAP / 'carpool-recovery-1.9.14-deploy.tar.gz'
RECOVERY_RECEIPT = BOOTSTRAP / 'carpool-recovery-1.9.14.json'
RELEASE_RECEIPT = BOOTSTRAP / 'verified-release-1.9.15.json'
UNIT = Path('/etc/systemd/system/otto-enterprise.service')
CGROUP = Path('/sys/fs/cgroup/system.slice/otto-enterprise.service')
OLD_BUILD = '1376fba9d2f1eac0a6f50825c2ca001c691c253c'
HELPERS = {
    '/usr/local/sbin/otto-enterprise-ci-deploy': '7879001db0e8fde08874d49444a11190067c7b0e5a5973031fef7862b9c3a758',
    '/usr/local/libexec/otto-enterprise-ci/publish-update-mirror': '4e2ecf9db8f031093c30d837f28c444cf235832d82b3e2712d405b27a9c05099',
    '/usr/local/libexec/otto-enterprise-ci/rollback-update-mirror': '24f2ed9983878aa134401821b725a772ada837ca855e7b95c9f0de2c71df7fc4',
}
DEPLOY_FILES = ('lib/common.sh', 'tools/verify-release.mjs', 'tools/health-check.mjs')
PROPERTIES = ('LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID',
              'FragmentPath', 'DropInPaths', 'ControlGroup', 'Result', 'ExecMainStatus',
              'InvocationID', 'ExecMainStartTimestampMonotonic', 'NRestarts',
              'ExecStart', 'EnvironmentFiles', 'WorkingDirectory', 'User', 'Group', 'KillMode')


def compact(data):
    return json.dumps(data, sort_keys=True, separators=(',', ':')).encode()


def sha_file(path, private=False, limit=256 * 1024 * 1024):
    # Hash bounded input; never return or print bytes from private artifacts.
    return p.digest(p.read_trusted(path, private, limit))


def validate_active(state):
    p.need(state.get('LoadState') == 'loaded' and state.get('ActiveState') == 'active'
           and state.get('SubState') == 'running' and state.get('Result') == 'success'
           and state.get('ExecMainStatus') == '0'
           and bool(re.fullmatch('[1-9][0-9]*', state.get('MainPID', '')))
           and state.get('ControlPID') == '0', 'Managed service is not healthy active')
    p.need(state.get('FragmentPath') == UNIT.as_posix() and not state.get('DropInPaths')
           and state.get('ControlGroup') == '/system.slice/otto-enterprise.service'
           and state.get('KillMode') == 'control-group'
           and state.get('WorkingDirectory') == '/opt/otto-enterprise/current'
           and state.get('User') == state.get('Group') == 'otto-enterprise',
           'Managed service definition mismatch')
    p.need(state.get('EnvironmentFiles') == '/etc/otto-enterprise/enterprise.env (ignore_errors=no)',
           'Managed service environment source mismatch')
    p.need(bool(re.fullmatch('[a-f0-9]{32}', state.get('InvocationID', '')))
           and state.get('ExecMainStartTimestampMonotonic', '').isdigit(),
           'Service invocation identity missing')
    p.need('/opt/otto-enterprise/runtime/current/bin/node' in state.get('ExecStart', '')
           and '/opt/otto-enterprise/current/run.mjs' in state.get('ExecStart', ''),
           'Managed service command differs')


def same_invocation(first, second):
    return all(first.get(key) == second.get(key) for key in
               ('MainPID', 'InvocationID', 'ExecMainStartTimestampMonotonic', 'NRestarts'))


def validate_acceptance(receipt, commit, park, now):
    p.need(receipt.get('schema') == 'otto-carpool-activation-acceptance-v1'
           and receipt.get('releaseAccepted') is True and receipt.get('readOnlyEvidence') is True
           and receipt.get('sourceCommit') == commit and receipt.get('parkId') == park
           and receipt.get('version') == '1.9.15' and receipt.get('schemaVersion') == 26,
           'Fresh independent release acceptance required')
    stamp = receipt.get('verifiedAtUnix')
    p.need(type(stamp) is int and 0 <= now - stamp <= 900, 'Release acceptance stale or future')
    for key in ('runtimeBuildCommit',):
        p.need(bool(re.fullmatch('[a-f0-9]{40}', receipt.get(key, ''))), 'Release content identity missing')
    for key in ('environmentSha256', 'manifestSha256', 'recoveryReceiptSha256', 'releaseReceiptSha256'):
        p.need(bool(re.fullmatch('[a-f0-9]{64}', receipt.get(key, ''))), 'Acceptance digest missing')
    p.need(bool(re.fullmatch('[A-Za-z0-9_-]{1,128}', receipt.get('organizationId', ''))),
           'Verified park organization ID missing')
    p.need(receipt.get('helperSha256') == HELPERS, 'Fixed gateway identities changed')
    validate_active(receipt.get('service', {}))


class RecoveryRequired(p.Refusal):
    pass


def execute_transaction(host):
    """Every side-effect intent is durable before the corresponding action.

    The adapter owns both locks for this entire call. Exceptions after a stop
    intent are not retried. Candidate rollback requires a new proven stop,
    including all descendants. Interruption (BaseException) deliberately does
    not trigger guessed compensation; the durable journal preserves last intent.
    """
    old, candidate = host.prepare()
    host.record('preflighted')
    try:
        host.revalidate(old, require_old_invocation=True)
        host.record('stopping-old')
        host.stop(compensation=False)
        host.record('stopped-old')
        host.revalidate(old, require_old_invocation=False)
        host.record('installing-env')
        host.install(candidate, old)
        host.record('installed-env')
        host.record('starting-new')
        host.start()
        host.record('accepting-new')
        host.accept(candidate, changed=True)
        host.record('completed', activated=True)
        return {'state': 'completed', 'activated': True}
    except Exception:
        # Exact current bytes, not an exception string or assumed rename result.
        try:
            current = host.current_environment()
            p.need(current in (old, candidate), 'Unknown live environment bytes')
            # Even a failed start or rename/fsync ambiguity must be stopped and
            # proved empty before any restore. A timed-out old stop is UNKNOWN:
            # never race the existing stop job with another stop or a start.
            p.need(host.last_step not in ('preflighted', 'stopping-old'),
                   'Old stop result not proven; manual reconciliation required')
            host.record('stopping-candidate')
            host.stop(compensation=True)
            host.record('stopped-candidate')
            host.revalidate(current, require_old_invocation=False)
            host.record('restoring-env')
            host.install(old, current)
            host.record('restored-env')
            host.record('starting-restored')
            host.start()
            host.record('accepting-restored')
            host.accept(old, changed=False)
            host.record('rolled-back', activated=False, rollbackKind='same-release-configuration')
            return {'state': 'rolled-back', 'activated': False,
                    'rollbackKind': 'same-release-configuration'}
        except Exception:
            # Preserve all files and systemd state. In particular do not restore
            # files under a possibly alive candidate, kill -9, or reboot.
            try:
                host.record('recovery-required', activated=False, retainEvidence=True)
            except Exception:
                pass
            raise RecoveryRequired('Configuration outcome requires independent recovery review') from None


class ProductionHost:
    def __init__(self, commit, park, phase):
        self.commit, self.park, self.phase = commit, park, phase
        self.txn = None
        self.last_step = None
        self.sequence = 0
        self.started_invocation = None

    def state(self, timeout=8):
        raw = p.run(['/usr/bin/systemctl', 'show', p.SERVICE,
                     *['--property=' + key for key in PROPERTIES]], timeout=timeout).decode('utf-8')
        pairs = [line.split('=', 1) for line in raw.splitlines() if '=' in line]
        p.need(len({key for key, _ in pairs}) == len(PROPERTIES), 'Incomplete service observation')
        return dict(pairs)

    def resolve_pointer(self, pointer, required_parent):
        p.root_directory(pointer.parent)
        info = pointer.lstat()
        p.need(stat.S_ISLNK(info.st_mode) and info.st_uid == info.st_gid == 0,
               'Managed release pointer custody mismatch')
        raw = Path(os.readlink(pointer))
        target = raw if raw.is_absolute() else pointer.parent / raw
        p.need(target.parent == required_parent, 'Managed pointer escapes fixed directory')
        p.root_directory(target)
        p.need(target.resolve(strict=True) == target, 'Nested release alias refused')
        return target

    def identities(self):
        paths = [*map(Path, HELPERS), UNIT, self.node,
                 *(p.DEPLOY / item for item in DEPLOY_FILES)]
        return {str(path): sha_file(path) for path in paths}

    def validate_recovery(self):
        raw = p.read_trusted(RECOVERY_RECEIPT, private=True)
        p.need(p.digest(raw) == self.acceptance['recoveryReceiptSha256'], 'Recovery receipt changed')
        receipt = p.json_object(raw)
        p.need(receipt.get('schema') == 'otto-preserved-1.9.14-recovery-v1'
               and receipt.get('version') == '1.9.14' and receipt.get('buildCommit') == OLD_BUILD
               and receipt.get('restoreDrillPassed') is True
               and receipt.get('gatewayTransactionUnmodified') is True,
               'Independent 1.9.14 recovery identity missing')
        env = p.read_trusted(RECOVERY_ENV, private=True)
        old, _ = p.parse_env(env)
        p.need(old.get('OTTO_APP_VERSION') == '1.9.14' and old.get('OTTO_BUILD_COMMIT') == OLD_BUILD
               and p.digest(env) == receipt.get('environmentSha256')
               and sha_file(RECOVERY_DEPLOY, private=True) == receipt.get('deployArchiveSha256'),
               'Preserved 1.9.14 recovery assets mismatch')

    def validate_release_receipt(self):
        raw = p.read_trusted(RELEASE_RECEIPT, private=True)
        p.need(p.digest(raw) == self.acceptance['releaseReceiptSha256'], 'Independent release receipt changed')
        receipt = p.json_object(raw)
        p.need(receipt.get('schema') == 'otto-verified-release-read-only-v1'
               and receipt.get('sourceCommit') == self.commit
               and receipt.get('runtimeBuildCommit') == self.build
               and receipt.get('version') == '1.9.15' and receipt.get('schemaVersion') == 26
               and receipt.get('upgradeAccepted') is True
               and receipt.get('canaryAccepted') is True
               and receipt.get('productionHealthy') is True,
               'Independent completed upgrade acceptance missing')

    def prepare(self):
        p.checked_inputs(self.commit, self.park, self.phase)
        self.acceptance_raw = p.read_trusted(ACCEPTANCE, private=True)
        self.acceptance = p.json_object(self.acceptance_raw)
        validate_acceptance(self.acceptance, self.commit, self.park, int(time.time()))
        self.target = self.resolve_pointer(p.CURRENT, p.INSTALL / 'releases')
        runtime = self.resolve_pointer(p.INSTALL / 'runtime/current', p.INSTALL / 'runtime')
        self.node = runtime / 'bin/node'
        self.manifest_raw = p.read_trusted(self.target / 'manifest.json', limit=4 * 1024 * 1024)
        self.manifest = p.json_object(self.manifest_raw)
        self.build = p.validate_release(self.manifest, self.commit)
        p.need(self.target.name == '1.9.15-' + self.build[:12]
               and self.build == self.acceptance['runtimeBuildCommit']
               and p.digest(self.manifest_raw) == self.acceptance['manifestSha256'], 'Release binding differs')
        self.bound_files = self.identities()
        p.need(self.bound_files == self.acceptance.get('boundFilesSha256'), 'Accepted helper, Node or unit changed')
        p.need(all(self.bound_files[name] == sha for name, sha in HELPERS.items()), 'Gateway hash pin failed')
        p.need(p.run([self.node, '--version']).strip() == b'v22.23.1', 'Fixed Node runtime differs')
        strict = p.json_object(p.run([self.node, '--max-old-space-size=256',
                                     p.DEPLOY / 'tools/verify-release.mjs', self.target]))
        p.validate_strict_summary(strict, self.manifest)
        self.validate_recovery()
        self.validate_release_receipt()
        old = self.current_environment()
        values, _ = p.parse_env(old)
        p.need(values.get('OTTO_BUILD_COMMIT') == self.build
               and p.digest(old) == self.acceptance['environmentSha256'], 'Active configuration identity differs')
        candidate = p.candidate_environment(old, p.read_trusted(p.KEY_FILE, True, 64),
                                             self.commit, self.park, self.phase)
        p.need(candidate != old, 'Already-active configuration requires no replay')
        self.initial_state = self.state()
        validate_active(self.initial_state)
        p.need(self.initial_state == self.acceptance['service'], 'Accepted service invocation changed')
        self.check_loaded_environment(old)
        self.health(old)
        self.verify_park(old)
        self.ensure_staging()
        self.txn = STAGING / (self.commit[:12] + '-' + self.phase + '-' + p.digest(self.park.encode())[:12])
        p.need(not self.txn.exists() and not self.txn.is_symlink(), 'Existing transaction: no blind replay')
        p.durable_directory(self.txn)
        p.durable_file(self.txn / 'old.env', old)
        p.durable_file(self.txn / 'candidate.env', candidate)
        p.durable_file(self.txn / 'acceptance.json', self.acceptance_raw)
        p.durable_file(self.txn / 'binding.json', compact({
            'sourceCommit': self.commit, 'runtimeBuildCommit': self.build, 'phase': self.phase,
            'parkId': self.park, 'oldEnvironmentSha256': p.digest(old),
            'candidateEnvironmentSha256': p.digest(candidate), 'boundFilesSha256': self.bound_files,
            'manifestSha256': p.digest(self.manifest_raw), 'service': self.initial_state,
            'executorSha256': sha_file(Path(__file__).resolve()), 'frozenPrimitivesSha256': DRAFT_SHA,
            'independentRecoveryReceiptSha256': self.acceptance['recoveryReceiptSha256'],
            'gatewayTransactionModified': False}))
        self.config_probe(self.txn / 'candidate.env')
        return old, candidate

    def ensure_staging(self):
        p.root_directory(BOOTSTRAP)
        if not STAGING.exists():
            p.durable_directory(STAGING)
        p.root_directory(STAGING)
        p.need(stat.S_IMODE(STAGING.lstat().st_mode) == 0o700, 'Private transaction directory required')

    def record(self, step, **fields):
        # Update last_step only after successful durable journal commit.
        number = self.sequence + 1
        p.durable_file(self.txn / ('%02d-%s.json' % (number, step)), compact({
            'schema': 'otto-carpool-config-transaction-v1', 'step': step,
            'atUnix': int(time.time()), 'sourceCommit': self.commit,
            'runtimeBuildCommit': self.build, **fields}))
        self.sequence, self.last_step = number, step

    def current_environment(self):
        return p.read_trusted(p.CONFIG, private=True)

    def revalidate(self, expected_env, require_old_invocation=False):
        p.need(self.resolve_pointer(p.CURRENT, p.INSTALL / 'releases') == self.target
               and p.read_trusted(self.target / 'manifest.json', limit=4 * 1024 * 1024) == self.manifest_raw
               and self.identities() == self.bound_files
               and self.current_environment() == expected_env
               and p.read_trusted(ACCEPTANCE, True) == self.acceptance_raw,
               'Live identity changed during configuration transaction')
        self.validate_recovery()
        self.validate_release_receipt()
        if require_old_invocation:
            validate_acceptance(self.acceptance, self.commit, self.park, int(time.time()))
            current = self.state()
            validate_active(current)
            p.need(current == self.initial_state, 'Old service invocation changed')

    def cgroup_empty(self):
        p.need(Path('/sys/fs/cgroup/cgroup.controllers').is_file(), 'cgroup v2 required')
        p.need(not CGROUP.is_symlink(), 'Unexpected service cgroup alias')
        if not CGROUP.exists():
            return True
        for directory, names, _ in os.walk(CGROUP, followlinks=False):
            paths = [Path(directory), *(Path(directory) / name for name in names)]
            p.need(not any(path.is_symlink() for path in paths), 'Cgroup descendant alias refused')
            procs = Path(directory) / 'cgroup.procs'
            events = Path(directory) / 'cgroup.events'
            try:
                p.need(not procs.read_text().strip(), 'Service descendant process remains')
                parsed = dict(line.split() for line in events.read_text().splitlines())
                p.need(parsed.get('populated') == '0', 'Service descendant cgroup populated')
            except FileNotFoundError:
                # A disappearing directory is safe only if it really disappeared.
                p.need(not Path(directory).exists(), 'Incomplete cgroup observation')
        return True

    def stop(self, compensation):
        # Timeout exceeds installed 60 s systemd stop timeout. Never manually kill.
        p.run(['/usr/bin/systemctl', 'stop', p.SERVICE], timeout=80)
        for sample in range(2):
            state = self.state()
            p.need(state.get('ControlPID') == '0' and not state.get('DropInPaths'), 'Service stop job remains')
            p.validate_stop_evidence({**state, 'stopCommandSucceeded': True, 'cgroupV2': True,
                                     'cgroupEmpty': self.cgroup_empty(), 'descendantPopulated': 0}, compensation)
            if sample == 0:
                time.sleep(0.2)

    def install(self, desired, expected):
        p.need(self.current_environment() == expected, 'Environment changed before atomic install')
        temp = p.CONFIG.parent / ('.otto-carpool-' + self.txn.name + '-%02d.env' % self.sequence)
        p.root_directory(p.CONFIG.parent)
        p.durable_file(temp, desired)
        p.need(temp.lstat().st_dev == p.CONFIG.lstat().st_dev, 'Atomic environment stage is not same filesystem')
        p.need(self.current_environment() == expected, 'Environment changed during atomic staging')
        os.replace(temp, p.CONFIG)
        parent = os.open(p.CONFIG.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        p.need(self.current_environment() == desired, 'Atomic installation bytes differ')

    def start(self):
        p.run(['/usr/bin/systemctl', 'start', p.SERVICE], timeout=35)
        observed = self.state()
        validate_active(observed)
        p.need(observed['InvocationID'] != self.initial_state['InvocationID'], 'Old service invocation reused')
        self.started_invocation = observed
        p.durable_file(self.txn / ('invocation-%02d.json' % self.sequence), compact(observed))

    def check_loaded_environment(self, expected):
        before = self.state()
        validate_active(before)
        path = Path('/proc') / before['MainPID'] / 'environ'
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            raw = os.read(fd, 1024 * 1024 + 1)
        finally:
            os.close(fd)
        p.need(len(raw) <= 1024 * 1024, 'Process environment exceeds limit')
        values = {}
        for row in raw.split(b'\0'):
            if b'=' in row:
                key, value = row.split(b'=', 1)
                name = key.decode('utf-8')
                p.need(name not in values, 'Ambiguous loaded environment')
                values[name] = value.decode('utf-8')
        wanted, _ = p.parse_env(expected)
        p.need(all(values.get(key) == value for key, value in wanted.items()), 'Service did not load exact configuration')
        p.need(all(key in wanted or key not in values for key in p.MUTABLE), 'Unconfigured mutable value injected')
        p.need(same_invocation(before, self.state()), 'Service restarted during environment observation')

    def health(self, expected, timeout=40):
        values, _ = p.parse_env(expected)
        shell = 'set -Eeuo pipefail; source "$1"; otto_load_config "$2"; shift 2; exec "$@"'
        mode = 'allow-sms-disabled' if values.get('OTTO_ALLOW_SMS_DISABLED') == '1' else 'require-sms'
        result = p.json_object(p.run(['/bin/bash', '-c', shell, 'otto-carpool-health',
            p.DEPLOY / 'lib/common.sh', p.CONFIG, self.node, p.DEPLOY / 'tools/health-check.mjs',
            'http://127.0.0.1:7778', '1.9.15', self.build, '26', mode], timeout=timeout))
        p.need(result.get('ok') is True, 'Live private health failed')
        all_caps = ('park_carpool_requests_v1', 'park_carpool_mls_v1',
                    'park_carpool_invitations_v1', 'park_carpool_groups_v1')
        requests = values.get(p.FLAGS[0]) in ('true', '1')
        invitations = requests and values.get(p.FLAGS[1]) in ('true', '1')
        groups = invitations and values.get(p.FLAGS[2]) in ('true', '1')
        desired = set(all_caps[:2] if requests else ())
        if invitations:
            desired.add(all_caps[2])
        if groups:
            desired.add(all_caps[3])
        actual = set(result.get('health', {}).get('capabilities', [])).intersection(all_caps)
        p.need(actual == desired, 'Live runtime phase capabilities differ')

    def verify_park(self, expected, timeout=5):
        organization = self.acceptance['organizationId']
        # The shipped bounded fetcher imposes a whole-body deadline (not a
        # per-chunk socket timeout). Only minimal identity booleans leave Node.
        script = """
const {pathToFileURL}=await import('node:url');
const {fetchHealthJson}=await import(pathToFileURL(process.argv[1]).href);
const org=process.argv[2],park=process.argv[3];
if(!/^[A-Za-z0-9_-]{1,128}$/.test(org))throw Error('invalid organization');
const result=await fetchHealthJson('http://127.0.0.1:7778/enterprise/platform/organizations/'+org+'/overview',
 {headers:{'x-otto-admin-token':process.env.OTTO_ENTERPRISE_ADMIN_TOKEN},deadline:performance.now()+Number(process.argv[4])});
if(result.organization?.id!==org||result.park?.id!==park||result.park?.status!=='active')throw Error('park mismatch');
process.stdout.write(JSON.stringify({ok:true,parkActive:true}));
"""
        shell = 'set -Eeuo pipefail; source "$1"; otto_load_config "$2"; shift 2; exec "$@"'
        result = p.json_object(p.run(['/bin/bash', '-c', shell, 'otto-park-readback',
            p.DEPLOY / 'lib/common.sh', p.CONFIG, self.node, '--input-type=module', '-e', script,
            p.DEPLOY / 'tools/health-check.mjs', organization, self.park, max(1, int(timeout * 1000) - 200)], timeout=timeout))
        p.need(result == {'ok': True, 'parkActive': True}, 'Live park identity is not active')

    def config_probe(self, candidate):
        shell = 'set -Eeuo pipefail; source "$1"; otto_load_config "$2"; shift 2; exec "$@"'
        p.run(['/bin/bash', '-c', shell, 'otto-config-parser', p.DEPLOY / 'lib/common.sh', candidate,
               self.node, '--input-type=module', '-e', p.RUNTIME_PROBE,
               self.target / 'src/modules/park_carpool/parkCarpoolConfig.js', self.phase, self.park])

    def accept(self, expected, changed):
        deadline = time.monotonic() + 60
        def remaining(cap):
            left = deadline - time.monotonic()
            p.need(left > 0, 'Acceptance total deadline exceeded')
            return min(cap, left)
        self.revalidate(expected)
        before = self.state(timeout=remaining(8))
        validate_active(before)
        p.need(self.started_invocation is not None and same_invocation(before, self.started_invocation),
               'Accepted service is not this transaction invocation')
        self.check_loaded_environment(expected)
        # Only TCP connection-not-ready may retry. Any HTTP/identity/license/
        # encryption rejection from the actual health checker fails immediately.
        startup_deadline = min(deadline, time.monotonic() + 15)
        while True:
            try:
                with socket.create_connection(('127.0.0.1', 7778), timeout=remaining(1)):
                    pass
                break
            except (ConnectionRefusedError, TimeoutError):
                p.need(same_invocation(before, self.state(timeout=remaining(3))),
                       'Service restarted before health readiness')
                if time.monotonic() >= startup_deadline:
                    raise
                time.sleep(min(0.2, remaining(0.2)))
        self.health(expected, timeout=remaining(40))
        self.verify_park(expected, timeout=remaining(5))
        after = self.state(timeout=remaining(8))
        p.need(same_invocation(before, after), 'Service restarted during acceptance')
        self.revalidate(expected)
        remaining(1)
        p.durable_file(self.txn / ('acceptance-%02d.json' % self.sequence), compact({
            'sourceCommit': self.commit, 'runtimeBuildCommit': self.build,
            'environmentSha256': p.digest(expected), 'InvocationID': after['InvocationID'],
            'MainPID': after['MainPID'], 'verifiedAtUnix': int(time.time()),
            'privateHealthPassed': True, 'livePhaseCapabilitiesPassed': True,
            'loadedConfigurationExact': True, 'activeParkReadbackPassed': True,
            'mapApiLiveRequestPerformed': False, 'actorBusinessReadPerformed': False,
            'changedConfigurationAccepted': changed}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', required=True)
    parser.add_argument('--expected-commit', required=True)
    parser.add_argument('--verified-park-id', required=True)
    parser.add_argument('--phase', required=True, choices=('requests', 'groups'))
    args = parser.parse_args()
    p.need(sys.platform == 'linux' and os.geteuid() == 0, 'Linux root required')
    os.umask(0o077)
    p.checked_inputs(args.expected_commit, args.verified_park_id, args.phase)
    p.trusted_file(DRAFT)
    p.trusted_file(Path(__file__).resolve())
    with p.locked(p.PRODUCTION_LOCK), p.locked(p.UPGRADE_LOCK):
        result = execute_transaction(ProductionHost(args.expected_commit, args.verified_park_id, args.phase))
    print(json.dumps(result))
    return 0 if result['state'] == 'completed' else 3


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('Configuration not accepted; preserve private transaction and reconcile independently', file=sys.stderr)
        raise SystemExit(2)
