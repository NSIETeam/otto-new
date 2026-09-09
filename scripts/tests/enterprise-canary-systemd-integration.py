#!/usr/bin/env python3
"""Actual canary controller/systemd isolation acceptance on disposable hosted CI.

Uses synthetic migration/HTTP adapters (not a real SQLCipher/business migration).
The production controller, worker, health predicates, cgroup and namespaces are
unmodified. No production service, user data, secrets, outbound traffic or reboot.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(argv, *, env=None, timeout=15, check=True):
    result = subprocess.run(argv, env=env or os.environ.copy(), timeout=timeout,
                            text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"{Path(argv[0]).name} failed ({result.returncode}): {result.stderr[:500]}")
    return result


def write(file, value, mode=0o600):
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open('x') as stream:
        stream.write(value)
    file.chmod(mode)


MIGRATION = r'''
import fs from 'node:fs';
import net from 'node:net';
import assert from 'node:assert/strict';
const work = process.env.OTTO_ENTERPRISE_DIR;
const fixture = JSON.parse(fs.readFileSync(work + '/fixture.json', 'utf8'));
assert.deepEqual(process.argv.slice(2), ['/run/otto-canary/package/release', work, '--baseline', '/run/otto-canary/control/baseline.json']);
assert.equal(process.getuid() > 0, true);
assert.equal(process.env.OTTO_ENTERPRISE_CANARY_MODE, '1');
for (const name of ['ALIYUN_SMS_ACCESS_KEY_ID','ALIYUN_SMS_ACCESS_KEY_SECRET','ALIYUN_SMS_SIGN_NAME','ALIYUN_SMS_TEMPLATE_ID','OTTO_ENTERPRISE_FEISHU_APP_SECRET','HTTPS_PROXY','NODE_OPTIONS']) assert.equal(process.env[name], undefined);
assert.notEqual(process.env.OTTO_ENTERPRISE_ADMIN_TOKEN, fixture.productionAdmin);
assert.ok(process.env.OTTO_ENTERPRISE_ADMIN_TOKEN.length >= 32);
assert.equal(fs.readFileSync(process.env.OTTO_DATABASE_ENCRYPTION_KEY_FILE).length, 32);
assert.throws(() => fs.readFileSync(fixture.rollback));
assert.throws(() => fs.writeFileSync(fixture.rollback, 'corrupted'));
assert.throws(() => fs.writeFileSync('/run/otto-canary/package/forbidden', 'x'));
assert.throws(() => fs.writeFileSync('/run/otto-canary/control/forbidden', 'x'));
assert.throws(() => fs.writeFileSync('/tmp/forbidden', 'x'));
assert.equal(fs.existsSync(fixture.hostSocket), false);
assert.equal(fs.existsSync(fixture.hostMarker), false);
async function connectionDenied(options) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(options);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('connection denial timed out')); }, 1000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error('host connection escaped isolation')); });
    socket.once('error', () => { clearTimeout(timer); resolve(); });
  });
}
await connectionDenied({path: fixture.hostSocket});
await connectionDenied({host: '127.0.0.1', port: fixture.hostPort});
// Also test an otherwise accessible pathname socket outside /run: AF_UNIX is disabled.
await connectionDenied({path: fixture.otherSocket});
fs.writeFileSync(work + '/isolation-probe.json', JSON.stringify({passed:true,pid:process.pid,parentPid:process.ppid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8')}));
fs.appendFileSync(work + '/data.db', '\nmigrated-to-schema-41');
if (fixture.mode === 'migration-exit7') process.exit(7);
'''

RUNTIME = r'''
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
const work = process.env.OTTO_ENTERPRISE_DIR;
const fixture = JSON.parse(fs.readFileSync(work + '/fixture.json', 'utf8'));
if (!fs.existsSync(work + '/isolation-probe.json')) process.exit(8);
const version = process.env.OTTO_APP_VERSION, buildCommit = process.env.OTTO_BUILD_COMMIT;
if (fixture.mode === 'oom') {
  const buffers = []; setInterval(() => buffers.push(Buffer.alloc(32 * 1024 * 1024, 1)), 10);
  await new Promise(() => {});
}
const server = http.createServer((request, response) => {
  let body;
  if (request.url === '/enterprise/health') body = {status:'ok',service:'otto-enterprise',apiVersion:4,version,appVersion:version,capabilities:fixture.capabilities};
  else if (request.url === '/enterprise/legal') body = [{id:'terms',version:'1',hash:'a'.repeat(64)},{id:'privacy',version:'1',hash:'b'.repeat(64)}];
  else if (request.url === '/enterprise/deployment/status' && request.headers['x-otto-admin-token'] === process.env.OTTO_ENTERPRISE_ADMIN_TOKEN) body = {runtime:{version,buildCommit},license:{enforce:true,status:'active'},database:{ready:true,schemaVersion:41},operationsSecurity:{sqlCipher:{state:'active'}}};
  else { response.writeHead(403); response.end(); return; }
  response.setHeader('content-type','application/json'); response.end(JSON.stringify(body));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.OTTO_ENTERPRISE_READY_FILE, JSON.stringify({host:'127.0.0.1',port:server.address().port,version,buildCommit}), {flag:'wx',mode:0o600}));
if (fixture.mode === 'residual') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),90000)"], {stdio:'ignore'});
  fs.writeFileSync(work + '/child.pid', String(child.pid));
}
process.on('SIGTERM', () => {
  if (fixture.mode === 'hang-stop') return;
  if (fixture.mode === 'runtime-exit7') process.exit(7);
  server.close(() => setTimeout(() => process.exit(0), fixture.mode === 'drain45' ? 45000 : 10));
});
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work-dir', required=True)
    parser.add_argument('--evidence-dir', required=True)
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0, 'Linux root required')
    for key, expected in {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted',
                          'RUNNER_OS':'Linux','OTTO_DISPOSABLE_SYSTEMD_ACCEPTANCE':'1'}.items():
        require(os.environ.get(key) == expected, 'refusing non-disposable hosted execution')
    require(Path('/proc/1/comm').read_text().strip() == 'systemd', 'real systemd required')
    require(os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net'), 'harness must be network isolated')
    require(run(['/usr/bin/stat','-f','-c','%T','/sys/fs/cgroup']).stdout.strip() == 'cgroup2fs', 'cgroup v2 required')
    require(not Path('/var/lib/otto-enterprise').exists() and not Path('/opt/otto-enterprise').exists(), 'production paths present')
    require(not Path('/run/otto-canary').exists() and not Path('/run/otto-canary').is_symlink(),
            'worker view must exist only inside the unit namespace')
    workspace = Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True)
    temporary = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    require(workspace.is_relative_to('/home/runner/work') and temporary.is_relative_to('/home/runner/work'), 'hosted paths required')
    root = Path(args.work_dir)
    require(root.is_absolute() and root.parent.resolve() == temporary and root.name.startswith('otto-canary-') and not root.exists(), 'new bound work directory required')
    root.mkdir(mode=0o700)
    evidence = Path(args.evidence_dir)
    require(evidence.resolve(strict=True) == evidence and evidence.parent == temporary
            and evidence.name.startswith('otto-canary-evidence-') and evidence.is_dir()
            and not evidence.is_symlink() and evidence.stat().st_uid == workspace.stat().st_uid,
            'pre-created runner-owned evidence directory required')
    evidence_owner = evidence.stat()
    source = workspace / 'deployment/enterprise-oneclick'
    report = {'passed':False, 'scope':'real systemd/controller with synthetic migration and HTTP adapters', 'source':os.environ['GITHUB_SHA'], 'cases':[]}
    owned_units = []
    owned_transactions = []
    owned_identity = False
    sockets = []
    host_paths = []
    try:
        require(run(['/usr/bin/getent','passwd','otto-upgrade-canary'], check=False).returncode != 0, 'canary account must not pre-exist in disposable runner')
        require(run(['/usr/bin/getent','group','otto-upgrade-canary'], check=False).returncode != 0, 'canary group must not pre-exist in disposable runner')
        owned_identity = True
        # Source the actual identity helper; never copy or relax its account validation.
        run(['/usr/bin/bash','-c','source "$1"; otto_prepare_canary_identity', 'fixture', str(source / 'lib/common.sh')])
        node_source = Path(os.environ['OTTO_CANARY_TEST_NODE']).resolve(strict=True)
        require(run([str(node_source),'--version']).stdout.strip() == 'v22.23.1', 'pinned Node 22.23.1 required')
        node = root / 'runtime/bin/node'
        node.parent.mkdir(parents=True)
        shutil.copyfile(node_source, node)
        node.chmod(0o755)
        # Host IPC is present and reachable by the dedicated UID absent isolation.
        run(['/usr/sbin/ip','link','set','lo','up'])
        tcp = socket.socket(); tcp.bind(('127.0.0.1',0)); tcp.listen(); sockets.append(tcp)
        marker = Path('/run') / f'otto-canary-probe-{os.getpid()}'
        require(not marker.exists(), 'host marker collision')
        write(marker, 'host IPC marker', 0o644); host_paths.append(marker)
        host_socket = Path('/run') / f'otto-canary-socket-{os.getpid()}'
        other_socket = Path('/var') / f'otto-canary-socket-{os.getpid()}'
        for target in [host_socket, other_socket]:
            require(not target.exists(), 'host probe collision')
            listener = socket.socket(socket.AF_UNIX); listener.bind(str(target)); target.chmod(0o666); listener.listen(); sockets.append(listener); host_paths.append(target)
        health_source = (source / 'tools/health-check.mjs').read_text()
        capabilities = re.findall(r"'([a-z0-9_]+)'", re.search(r'const requiredCapabilities = (\[[\s\S]*?\]);', health_source).group(1))
        require(len(capabilities) >= 18, 'health capabilities not found')
        for mode in ['success','drain45','migration-exit7','runtime-exit7','oom','residual','hang-stop']:
            case = root / mode; case.mkdir(mode=0o700)
            package = case / 'package'; package.mkdir(mode=0o700)
            for name in ['canary-worker.mjs','health-check.mjs']:
                destination = package / 'tools' / name; destination.parent.mkdir(exist_ok=True); shutil.copyfile(source / 'tools' / name, destination); destination.chmod(0o600)
            write(package / 'tools/migrate-check.mjs', MIGRATION)
            write(package / 'release/run.mjs', RUNTIME)
            write(package / 'release/manifest.json', json.dumps({'version':'1.9.15','buildCommit':'a'*40,'database':{'schemaTo':41}}))
            txn = case / 'txn'; txn.mkdir(mode=0o700); owned_transactions.append(txn)
            work = txn / 'canary/work'; work.mkdir(parents=True, mode=0o700); work.parent.chmod(0o700)
            rollback = txn / 'data.db.before'; write(rollback,'immutable rollback fixture')
            rollback_hash = hashlib.sha256(rollback.read_bytes()).hexdigest()
            write(txn / 'enterprise.env.before', '\n'.join(['OTTO_ENTERPRISE_PUBLIC_URL="https://example.invalid"','OTTO_ENTERPRISE_DEPLOYMENT_GRANTS="fixture-signed-grants"','OTTO_ENTERPRISE_ADMIN_TOKEN="production-admin-fixture-never-forward"','OTTO_ENTERPRISE_FEISHU_APP_SECRET="production-channel-secret-fixture"','ALIYUN_SMS_ACCESS_KEY_ID="sms-id-fixture"','ALIYUN_SMS_ACCESS_KEY_SECRET="sms-secret-fixture"','ALIYUN_SMS_SIGN_NAME="sms-sign-fixture"','ALIYUN_SMS_TEMPLATE_ID="sms-template-fixture"']))
            write(txn / 'database-inspection.before.json','{"rowCounts":{"sample":1}}')
            key = txn / 'database.key'; key.write_bytes(bytes(range(32))); key.chmod(0o600)
            for name in ['data.db','account-sync.key','attachment-storage.key','field-encryption.key']:
                write(work / name, 'synthetic fixture bytes')
            write(work / 'fixture.json', json.dumps({'mode':mode,'capabilities':capabilities,'rollback':str(rollback),'hostSocket':str(host_socket),'otherSocket':str(other_socket),'hostMarker':str(marker),'hostPort':tcp.getsockname()[1],'productionAdmin':'production-admin-fixture-never-forward'}))
            env = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','OTTO_DATABASE_ENCRYPTION_KEY_FILE':str(key),'OTTO_ALLOW_SMS_DISABLED':'0','HTTPS_PROXY':'http://proxy-secret-fixture.invalid'}
            started = time.monotonic()
            result = run([str(node),str(package / 'tools/canary-worker.mjs'),'launch','--transaction',str(txn)],env=env,timeout=255,check=False)
            elapsed = time.monotonic() - started
            witness_file = txn / 'canary-controller.json'
            require(witness_file.exists(), 'controller witness absent before unit launch')
            witness = json.loads(witness_file.read_text()); owned_units.append(witness['unit'])
            require(re.fullmatch(r'otto-upgrade-canary-[0-9a-f]{32}\.service',witness['unit']), 'unexpected unit identity')
            group = Path('/sys/fs/cgroup') / witness['cgroup'].lstrip('/')
            if group.exists():
                require('populated 0' in (group / 'cgroup.events').read_text() and not (group / 'cgroup.procs').read_text().strip(), 'unit has remaining processes')
            positive = mode in ['success','drain45']
            report['cases'].append({'mode': mode, 'exit': result.returncode, 'seconds': round(elapsed, 2),
                # Only root-produced fixed enums, never raw runner stderr or config.
                'launchDiagnostic': json.loads((txn / 'canary-launch-diagnostic.json').read_text())
                    if (txn / 'canary-launch-diagnostic.json').exists() else None,
                'observedUnit': run(['/usr/bin/systemctl','show',witness['unit'],
                    '--property=LoadState,ActiveState,MainPID,Result,ExecMainCode,ExecMainStatus'],check=False).stdout,
                'unitJournal': run(['/usr/bin/journalctl','--unit',witness['unit'],'--no-pager','--output=cat','--lines=12'],check=False).stdout[-4000:],
                'delivered': (txn / 'canary-deliverable.json').exists(), 'passed': False})
            require((result.returncode == 0) == positive, f'{mode}: unexpected controller result: {result.stderr[:300]}')
            require((txn / 'canary-deliverable.json').exists() == positive, 'failed unit delivered a database')
            if positive:
                run([str(node),str(package / 'tools/canary-worker.mjs'),'verify-deliverable','--transaction',str(txn)],env=env)
                probe = json.loads((work / 'isolation-probe.json').read_text()); require(probe['passed'] and witness['cgroup'] in probe['cgroup'], 'migration outside attested cgroup')
                require(probe['parentPid'] == witness['pid'], 'exec trampoline did not preserve worker MainPID')
                with (work / 'data.db').open('a') as stream: stream.write('tamper')
                require(run([str(node),str(package / 'tools/canary-worker.mjs'),'verify-deliverable','--transaction',str(txn)],env=env,check=False).returncode != 0,'changed database accepted')
            require(hashlib.sha256(rollback.read_bytes()).hexdigest() == rollback_hash
                    and (txn.stat().st_mode & 0o777) == 0o700
                    and (root.stat().st_mode & 0o777) == 0o700, 'rollback custody changed')
            require(elapsed < 250, 'fixed controller deadline exceeded')
            require('sms-secret-fixture' not in result.stderr + result.stdout and 'production-admin-fixture' not in result.stderr + result.stdout, 'credential leaked to controller output')
            report['cases'][-1].update(cgroupEmpty=True, passed=True)
        report['passed'] = True
    finally:
        # Never delete evidence or the dedicated account while a cgroup may live.
        cleanup_ok = True
        cleanup_errors = []
        for txn in owned_transactions:
            try:
                witness_file = txn / 'canary-controller.json'
                if witness_file.exists():
                    owned_units.append(json.loads(witness_file.read_text())['unit'])
            except Exception:
                cleanup_ok = False; cleanup_errors.append('controller-witness-unreadable')
        for unit in set(owned_units):
            if not re.fullmatch(r'otto-upgrade-canary-[0-9a-f]{32}\.service',unit): cleanup_ok = False; continue
            try:
                run(['/usr/bin/systemctl','stop',unit],timeout=65,check=False)
                observed = run(['/usr/bin/systemctl','show',unit,'--property=LoadState,ActiveState,MainPID'],check=False)
                fields = dict(line.split('=',1) for line in observed.stdout.splitlines() if '=' in line)
                require(fields.get('ActiveState') in {'inactive','failed'} and fields.get('MainPID') == '0'
                        and (observed.returncode == 0 or fields.get('LoadState') == 'not-found'), 'unit stop state unavailable')
                group = Path('/sys/fs/cgroup/system.slice') / unit
                if group.exists() and ('populated 0' not in (group / 'cgroup.events').read_text() or (group / 'cgroup.procs').read_text().strip()):
                    cleanup_ok = False; cleanup_errors.append('cgroup-not-empty'); continue
                run(['/usr/bin/systemctl','reset-failed',unit],check=False)
            except Exception:
                cleanup_ok = False; cleanup_errors.append('systemd-stop-or-proof-failed')
        for listener in sockets:
            try: listener.close()
            except Exception: cleanup_errors.append('probe-socket-close-failed')
        for target in host_paths:
            try: target.unlink(missing_ok=True)
            except Exception: cleanup_errors.append('probe-file-cleanup-failed')
        report['cleanupProven'] = cleanup_ok
        report['cleanupErrors'] = cleanup_errors
        if not cleanup_ok or cleanup_errors: report['passed'] = False
        (root / 'receipt.json').write_text(json.dumps(report,indent=2))
        # Keep TXN 0700. Only this secret-free receipt becomes readable by the
        # runner's artifact uploader; do not expose credential/work subtrees.
        fd = os.open(evidence / 'receipt.json', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            metadata = os.fstat(fd)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                    and metadata.st_uid in {0,evidence_owner.st_uid}, 'unsafe receipt target')
            os.ftruncate(fd,0)
            os.write(fd,json.dumps(report,indent=2).encode())
            os.fchown(fd,evidence_owner.st_uid,evidence_owner.st_gid)
            os.fchmod(fd,0o600)
            os.fsync(fd)
        finally: os.close(fd)
        if cleanup_ok and owned_identity:
            run(['/usr/sbin/userdel','otto-upgrade-canary'],check=False)
            run(['/usr/sbin/groupdel','otto-upgrade-canary'],check=False)
        require(cleanup_ok and not cleanup_errors, 'retained worker cgroup or cleanup failure requires investigation')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
