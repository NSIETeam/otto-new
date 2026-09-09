#!/usr/bin/env python3
"""REVIEW-ONLY harness for a disposable GitHub-hosted Linux systemd runner.

Uses the real configuration transaction engine, atomic file replacement and
systemctl/cgroup methods with nonce fixture targets. No production SSH, secrets,
data, package install, internet, map call, DB, or gateway transaction is used.
Product-specific acceptance is intentionally a fixture and is not claimed here.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location('activation', Path(__file__).with_name('carpool-config-activation.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = m.p


class FixtureInterruption(BaseException):
    pass


def main():
    p.need(sys.platform == 'linux' and os.geteuid() == 0, 'Disposable Linux root required')
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true'
           and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
           and os.environ.get('RUNNER_OS') == 'Linux'
           and os.environ.get('OTTO_DISPOSABLE_CONFIG_ACCEPTANCE') == '1',
           'Only explicit GitHub-hosted disposable harness execution permitted')
    p.need(Path('/run/systemd/system').is_dir() and Path('/sys/fs/cgroup/cgroup.controllers').is_file(),
           'Real systemd and cgroup v2 required')
    p.need(not Path('/etc/otto-enterprise').exists() and not Path('/var/lib/otto-ci-deploy').exists(),
           'Never run fixture on an Otto deployment')
    os.umask(0o077)
    nonce = uuid.uuid4().hex
    base = Path('/run') / ('otto-carpool-fixture-' + nonce)
    p.durable_directory(base)
    evidence = Path(os.environ['RUNNER_TEMP']) / ('otto-config-systemd-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'])
    evidence.mkdir(mode=0o700, exist_ok=True)
    evidence_owner = evidence.stat()
    cases = []
    run = m.bounded_run
    old_unit = '/etc/systemd/system/otto-enterprise.service'
    old_group = '/system.slice/otto-enterprise.service'
    production_paths = dict(service=p.SERVICE, config=p.CONFIG, group=m.CGROUP)

    def run_case(case, fault=None, interrupt=None, child=False):
        directory = base / case
        p.durable_directory(directory)
        service = 'otto-carpool-fixture-' + nonce + '-' + case + '.service'
        unit = Path('/etc/systemd/system') / service
        p.need(re.fullmatch('otto-carpool-fixture-[a-f0-9]{32}-[a-z0-9-]+.service', service), 'Unsafe fixture unit name')
        p.need(not unit.exists(), 'Fixture unit collision')
        script = directory / 'service.py'
        code = '''import os,sys,time,subprocess,signal
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
if os.environ['FIXTURE_VALUE']=='exit7':sys.exit(7)
if os.environ.get('FIXTURE_CHILD')=='1':subprocess.Popen(['/usr/bin/sleep','120'])
while True:time.sleep(0.1)
'''
        p.durable_file(script, code.encode())
        config = directory / 'fixture.env'
        original = b'FIXTURE_VALUE=old\n' + (b'FIXTURE_CHILD=1\n' if child else b'')
        candidate = original.replace(b'=old', b'=exit7' if fault == 'exit7' else b'=new')
        p.durable_file(config, original)
        extra = 'ExecStop=/usr/bin/sleep 4\n' if fault == 'stop-timeout' else ''
        body = '[Unit]\nDescription=Disposable Otto config fixture\n[Service]\nType=simple\nUser=root\nGroup=root\nEnvironmentFile=' + str(config) + '\nExecStart=/usr/bin/python3 -I -S ' + str(script) + '\nRestart=no\nKillMode=control-group\nTimeoutStopSec=8\nPrivateNetwork=yes\nNoNewPrivileges=yes\n' + extra
        p.durable_file(unit, body.encode())
        p.SERVICE, p.CONFIG = service, config
        m.CGROUP = Path('/sys/fs/cgroup/system.slice') / service

        class Host(m.ProductionHost):
            def __init__(self):
                super().__init__('a' * 40, 'fixture-park', 'requests')
                self.build = 'b' * 40
                self.txn = directory / 'transaction'
                p.durable_directory(self.txn)
                self.stop_calls = 0
                self.actions = []

            def state(self, timeout=8):
                actual = super().state(timeout)
                # Independently verify the nonce identity before projecting
                # fixed production names for the frozen stop-contract function.
                p.need(actual['FragmentPath'] == str(unit) and not actual['DropInPaths'], 'Foreign fixture unit observed')
                p.need(actual['ControlGroup'] in ('', '/system.slice/' + service), 'Foreign fixture cgroup observed')
                actual['FragmentPath'] = old_unit
                actual['ControlGroup'] = old_group if actual['ControlGroup'] else ''
                return actual

            def prepare(self):
                self.initial_state = self.state()
                p.need(self.initial_state['ActiveState'] == 'active', 'Fixture did not start')
                self.verify_fixture_isolation(self.initial_state)
                p.durable_file(self.txn / 'old.env', original)
                p.durable_file(self.txn / 'candidate.env', candidate)
                return original, candidate

            def verify_fixture_isolation(self, state):
                proc = Path('/proc') / state['MainPID']
                service_net = (proc / 'ns/net').stat()
                host_net = Path('/proc/1/ns/net').stat()
                p.need((service_net.st_dev, service_net.st_ino) != (host_net.st_dev, host_net.st_ino),
                       'Fixture service inherited host network namespace')
                flags = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
                p.need(flags.get('NoNewPrivs', '').strip() == '1', 'Fixture did not set NoNewPrivileges')

            def revalidate(self, expected_env, require_old_invocation=False):
                p.need(self.current_environment() == expected_env and p.read_trusted(unit) == body.encode(),
                       'Fixture identity changed')

            def record(self, step, **fields):
                super().record(step, **fields)
                if step == interrupt:
                    raise FixtureInterruption()

            def stop(self, compensation):
                self.stop_calls += 1
                self.actions.append('stop-candidate' if compensation else 'stop-old')
                if fault == 'stop-timeout' and not compensation:
                    # Real systemctl stop with a genuinely outstanding slow
                    # ExecStop. Only this fixture command gets a short deadline.
                    prior = p.run
                    p.run = lambda argv, timeout=45: run(argv, 0.05 if argv[:3] == ['/usr/bin/systemctl', 'stop', service] else timeout)
                    try:
                        return super().stop(compensation)
                    finally:
                        p.run = prior
                return super().stop(compensation)

            def install(self, desired, expected):
                self.actions.append('install-new' if desired == candidate else 'install-old')
                if fault == 'rename-before' and desired == candidate:
                    raise OSError('fixture rename-before')
                super().install(desired, expected)
                if fault == 'rename-after' and desired == candidate:
                    raise OSError('fixture fsync ambiguity')

            def start(self):
                self.actions.append('start')
                run(['/usr/bin/systemctl', 'start', service], 12)
                # Let an exit-7 candidate terminate before observation.
                time.sleep(0.15)
                state = self.state()
                p.need(state['ActiveState'] == 'active' and state['MainPID'] != '0', 'Fixture failed to start')
                self.started_invocation = state

            def accept(self, expected, changed):
                if fault == 'health' and changed:
                    raise p.Refusal('Fixture health rejection')
                state = self.state()
                p.need(state['ActiveState'] == 'active' and self.current_environment() == expected,
                       'Fixture health not active')
                self.verify_fixture_isolation(state)
                data = (Path('/proc') / state['MainPID'] / 'environ').read_bytes().split(b'\0')
                wanted = b'FIXTURE_VALUE=' + (b'new' if changed else b'old')
                p.need(wanted in data, 'Real new process did not load fixture environment')
                p.need(m.same_invocation(state, self.started_invocation), 'Fixture invocation changed')

        host = Host()
        try:
            run(['/usr/bin/systemctl', 'daemon-reload'], 12)
            run(['/usr/bin/systemctl', 'start', service], 12)
            if child:
                time.sleep(0.2)
                try:
                    host.cgroup_empty()
                except p.Refusal:
                    pass
                else:
                    raise AssertionError('Populated real cgroup was accepted as empty')
            if fault == 'unknown-unit':
                p.SERVICE = service[:-8] + '-missing.service'
                try:
                    try:
                        host.state()
                    except p.Refusal:
                        pass
                    else:
                        raise AssertionError('Unknown real systemd unit was accepted')
                finally:
                    p.SERVICE = service
                p.need(host.current_environment() == original and host.stop_calls == 0,
                       'Unknown-unit inspection unexpectedly mutated fixture')
                cases.append({'case': case, 'passed': True, 'result': {'state': 'refused-unknown-unit'}})
                return
            result = None
            try:
                result = m.execute_transaction(host)
            except FixtureInterruption:
                p.need(host.last_step == interrupt, 'Wrong interruption checkpoint')
                result = {'state': 'interrupted', 'lastDurableStep': interrupt}
            except m.RecoveryRequired:
                p.need(fault == 'stop-timeout', 'Unexpected real systemd recovery requirement')
                p.need(host.stop_calls == 1 and host.current_environment() == original,
                       'Stop timeout caused blind replay or environment mutation')
                result = {'state': 'recovery-required', 'stopCalls': host.stop_calls}
            if not interrupt and fault != 'stop-timeout':
                expected = 'rolled-back' if fault in ('health', 'exit7', 'rename-before', 'rename-after') else 'completed'
                p.need(result['state'] == expected, 'Incorrect actual transaction outcome')
                p.need(host.current_environment() == (original if expected == 'rolled-back' else candidate),
                       'Incorrect final actual environment')
            cases.append({'case': case, 'passed': True, 'result': result, 'actions': host.actions,
                          'fixtureConfigSha256': p.digest(host.current_environment())})
        finally:
            # Fixture-only cleanup after assertions, not recovery automation.
            # Exact nonce paths were constructed above; no wildcards or pkill.
            run(['/usr/bin/systemctl', 'stop', service], 15)
            host.cgroup_empty()
            run(['/usr/bin/systemctl', 'reset-failed', service], 8)
            p.need(unit.parent == Path('/etc/systemd/system') and nonce in unit.name,
                   'Fixture cleanup target escaped')
            unit.unlink()
            run(['/usr/bin/systemctl', 'daemon-reload'], 12)
            # Preserve nonce env/journals for evidence; never delete a broad dir.

    result = {'passed': False, 'productionTouched': False, 'cases': cases}
    try:
        for case, fault in [('success', None), ('health-rejected', 'health'), ('exit7-recovery', 'exit7'),
                            ('rename-before', 'rename-before'), ('rename-after', 'rename-after'),
                            ('stop-timeout', 'stop-timeout')]:
            run_case(case, fault)
        run_case('descendant-drain', child=True)
        run_case('unknown-unit-rejected', fault='unknown-unit')
        for index, step in enumerate(('preflighted', 'stopping-old', 'stopped-old', 'installing-env',
                                    'installed-env', 'starting-new', 'accepting-new', 'completed')):
            run_case('interrupt-%02d' % index, interrupt=step)
        for index, step in enumerate(('stopping-candidate', 'stopped-candidate', 'restoring-env',
                                    'restored-env', 'starting-restored', 'accepting-restored', 'rolled-back')):
            run_case('compensate-interrupt-%02d' % index, fault='health', interrupt=step)
        # Real nonblocking flock contention on nonce root-private files.
        for name in ('outer.lock', 'inner.lock'):
            lock = base / name
            with p.locked(lock):
                try:
                    with p.locked(lock):
                        raise AssertionError('Concurrent nonce lock unexpectedly acquired')
                except p.Refusal:
                    pass
        result.update(passed=True, realSystemd=True, realCgroupV2=True,
                      realAtomicRename=True, servicePrivateNetworkVerified=True,
                      serviceNoNewPrivilegesVerified=True, nonce=nonce, productHealthIsFixture=True,
                      productionDeploymentAcceptance=False,
                      sourceCommit=os.environ['GITHUB_SHA'],
                      executorSha256=hashlib_sha(Path(__file__).with_name('carpool-config-activation.py')))
    finally:
        p.SERVICE, p.CONFIG, m.CGROUP = production_paths['service'], production_paths['config'], production_paths['group']
        (evidence / 'receipt.json').write_text(json.dumps(result, indent=2))
        # Journals contain synthetic fixture values only; no production env copied.
        import shutil
        shutil.copytree(base, evidence / 'nonce-fixtures', dirs_exist_ok=False)
        # upload-artifact runs as the original runner user. Only synthetic
        # fixture copies change ownership; no production/root recovery assets.
        for directory, names, files in os.walk(evidence, followlinks=False):
            for path in [Path(directory), *(Path(directory) / name for name in names + files)]:
                p.need(not path.is_symlink(), 'Unexpected fixture evidence link')
                os.chown(path, evidence_owner.st_uid, evidence_owner.st_gid, follow_symlinks=False)
    print(json.dumps({'passed': result['passed'], 'cases': len(cases), 'productionTouched': False}))


def hashlib_sha(path):
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == '__main__':
    main()
