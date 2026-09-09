"""Local fixtures; no SSH, production API, root path writes or real systemctl."""
import importlib.util
import json
from pathlib import Path
import tempfile
import os
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

FILE = Path(__file__).with_name('carpool-config-activation.py')
spec = importlib.util.spec_from_file_location('activation', FILE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

COMMIT, BUILD, PARK = 'a' * 40, 'b' * 40, 'verified-park_1'
OLD, NEW = b'old fixture secrets\n', b'new fixture secrets\n'


def active():
    return dict(LoadState='loaded', ActiveState='active', SubState='running',
        Result='success', ExecMainStatus='0', MainPID='12', ControlPID='0',
        FragmentPath=m.UNIT.as_posix(), DropInPaths='', ControlGroup='/system.slice/otto-enterprise.service',
        KillMode='control-group', WorkingDirectory='/opt/otto-enterprise/current',
        User='otto-enterprise', Group='otto-enterprise',
        EnvironmentFiles='/etc/otto-enterprise/enterprise.env (ignore_errors=no)',
        InvocationID='c' * 32, ExecMainStartTimestampMonotonic='100', NRestarts='0',
        ExecStart='/opt/otto-enterprise/runtime/current/bin/node /opt/otto-enterprise/current/run.mjs')


def acceptance():
    return dict(schema='otto-carpool-activation-acceptance-v1', releaseAccepted=True,
        readOnlyEvidence=True, sourceCommit=COMMIT, runtimeBuildCommit=BUILD,
        version='1.9.15', schemaVersion=26, parkId=PARK, organizationId='org-example',
        verifiedAtUnix=1000, environmentSha256='d' * 64, manifestSha256='e' * 64,
        recoveryReceiptSha256='f' * 64, releaseReceiptSha256='1' * 64,
        helperSha256=m.HELPERS.copy(), service=active())


class Interrupted(BaseException):
    pass


class FixtureHost:
    def __init__(self, failure=None, interrupt=None):
        self.failure, self.interrupt = failure, interrupt
        self.current, self.alive = OLD, True
        self.last_step, self.steps, self.actions = None, [], []
        self.starts, self.stops, self.installs = 0, 0, 0

    def prepare(self):
        if self.failure == 'preflight':
            raise ValueError('fixture')
        self.actions.append('prepare')
        return OLD, NEW

    def record(self, step, **fields):
        self.steps.append((step, fields))
        self.last_step = step
        if step == self.interrupt:
            raise Interrupted()

    def revalidate(self, expected, require_old_invocation=False):
        if self.failure == 'old-identity' and require_old_invocation:
            raise ValueError('fixture')
        if self.failure == 'stopped-identity' and self.last_step == 'stopped-old':
            raise ValueError('fixture')
        if self.failure == 'changed-binding' and self.last_step == 'stopped-candidate':
            raise ValueError('fixture')
        assert self.current == expected

    def stop(self, compensation):
        self.stops += 1
        self.actions.append('stop-candidate' if compensation else 'stop-old')
        if self.failure == 'old-stop-timeout' and not compensation:
            raise ValueError('fixture unknown job')
        if self.failure in ('candidate-stop-timeout', 'populated-descendant', 'unknown-unit') and compensation:
            raise ValueError('fixture unproven stop')
        self.alive = False

    def install(self, desired, expected):
        assert not self.alive, 'Must never replace environment under live service'
        assert self.current == expected
        self.installs += 1
        self.actions.append('install-new' if desired == NEW else 'install-old')
        if self.failure == 'rename-before' and desired == NEW:
            raise OSError('fixture')
        if self.failure == 'unknown-bytes' and desired == NEW:
            self.current = b'unknown'
            raise OSError('fixture')
        if self.failure == 'restore-install' and desired == OLD:
            raise OSError('fixture')
        self.current = desired
        if self.failure == 'rename-after' and desired == NEW:
            raise OSError('fixture ambiguous fsync')

    def start(self):
        self.starts += 1
        self.actions.append('start-new' if self.current == NEW else 'start-old')
        self.alive = True
        if self.failure == 'new-start' and self.current == NEW:
            raise ValueError('fixture start rejected')
        if self.failure == 'restored-start' and self.current == OLD:
            raise ValueError('fixture restoration rejected')

    def accept(self, expected, changed):
        assert self.current == expected and self.alive
        self.actions.append('accept-new' if changed else 'accept-old')
        if changed and self.failure in ('health', 'candidate-stop-timeout', 'populated-descendant',
                    'unknown-unit', 'restore-install', 'restored-start', 'restored-health', 'changed-binding'):
            raise ValueError('fixture health rejected')
        if not changed and self.failure == 'restored-health':
            raise ValueError('fixture old health rejected')

    def current_environment(self):
        return self.current


class TransactionTests(unittest.TestCase):
    def test_happy_path_has_exact_order(self):
        h = FixtureHost()
        self.assertEqual(m.execute_transaction(h), dict(state='completed', activated=True))
        self.assertEqual(h.actions, ['prepare', 'stop-old', 'install-new', 'start-new', 'accept-new'])
        self.assertEqual((h.current, h.starts, h.stops), (NEW, 1, 1))

    def test_normal_health_rejection_stops_then_restores_same_release(self):
        h = FixtureHost('health')
        result = m.execute_transaction(h)
        self.assertEqual(result['state'], 'rolled-back')
        self.assertEqual(result['rollbackKind'], 'same-release-configuration')
        self.assertEqual(h.actions, ['prepare', 'stop-old', 'install-new', 'start-new', 'accept-new',
                                    'stop-candidate', 'install-old', 'start-old', 'accept-old'])
        self.assertNotIn('1.9.14', json.dumps(result))
        self.assertEqual((h.current, h.starts, h.stops), (OLD, 2, 2))

    def test_refused_preflight_never_stops(self):
        h = FixtureHost('preflight')
        with self.assertRaises(ValueError):
            m.execute_transaction(h)
        self.assertEqual(h.actions, [])

    def test_changed_old_identity_never_stops(self):
        h = FixtureHost('old-identity')
        with self.assertRaises(m.RecoveryRequired):
            m.execute_transaction(h)
        self.assertEqual(h.actions, ['prepare'])

    def test_old_stop_timeout_never_reissues_stop_or_changes_env(self):
        h = FixtureHost('old-stop-timeout')
        with self.assertRaises(m.RecoveryRequired):
            m.execute_transaction(h)
        self.assertEqual(h.actions, ['prepare', 'stop-old'])
        self.assertEqual((h.current, h.starts), (OLD, 0))

    def test_failed_new_start_is_stopped_before_restore(self):
        h = FixtureHost('new-start')
        self.assertEqual(m.execute_transaction(h)['state'], 'rolled-back')
        self.assertLess(h.actions.index('stop-candidate'), h.actions.index('install-old'))

    def test_rename_before_and_after_ambiguities_reconcile_exact_bytes(self):
        for failure in ('rename-before', 'rename-after'):
            with self.subTest(failure=failure):
                h = FixtureHost(failure)
                self.assertEqual(m.execute_transaction(h)['state'], 'rolled-back')
                self.assertEqual(h.current, OLD)
                self.assertLess(h.actions.index('stop-candidate'), h.actions.index('install-old'))

    def test_unknown_bytes_never_restore_or_restart(self):
        h = FixtureHost('unknown-bytes')
        with self.assertRaises(m.RecoveryRequired):
            m.execute_transaction(h)
        self.assertEqual(h.actions, ['prepare', 'stop-old', 'install-new'])
        self.assertEqual(h.current, b'unknown')

    def test_candidate_timeout_live_descendant_unknown_unit_never_restore(self):
        for failure in ('candidate-stop-timeout', 'populated-descendant', 'unknown-unit'):
            with self.subTest(failure=failure):
                h = FixtureHost(failure)
                with self.assertRaises(m.RecoveryRequired):
                    m.execute_transaction(h)
                self.assertEqual(h.current, NEW)
                self.assertEqual(h.actions[-1], 'stop-candidate')
                self.assertNotIn('install-old', h.actions)

    def test_restoration_failures_never_replay_mutation(self):
        for failure in ('restore-install', 'restored-start', 'restored-health', 'changed-binding'):
            with self.subTest(failure=failure):
                h = FixtureHost(failure)
                with self.assertRaises(m.RecoveryRequired):
                    m.execute_transaction(h)
                self.assertLessEqual(h.starts, 2)
                self.assertEqual(h.stops, 2)
                self.assertEqual(h.last_step, 'recovery-required')

    def test_interruption_at_every_successful_journal_step_does_not_guess_compensation(self):
        steps = ['preflighted', 'stopping-old', 'stopped-old', 'installing-env', 'installed-env',
                 'starting-new', 'accepting-new', 'completed']
        for step in steps:
            with self.subTest(step=step):
                h = FixtureHost(interrupt=step)
                with self.assertRaises(Interrupted):
                    m.execute_transaction(h)
                self.assertEqual(h.last_step, step)
                self.assertNotIn('install-old', h.actions)

    def test_interruption_at_every_compensation_step_does_not_replay(self):
        steps = ['stopping-candidate', 'stopped-candidate', 'restoring-env', 'restored-env',
                 'starting-restored', 'accepting-restored', 'rolled-back']
        for step in steps:
            with self.subTest(step=step):
                h = FixtureHost('health', interrupt=step)
                with self.assertRaises(Interrupted):
                    m.execute_transaction(h)
                self.assertEqual(h.last_step, step)
                self.assertLessEqual(h.starts, 2)


class ProductionContractTests(unittest.TestCase):
    def test_source_and_build_are_not_interchangeable(self):
        m.validate_acceptance(acceptance(), COMMIT, PARK, 1001)
        with self.assertRaises(m.p.Refusal):
            m.validate_acceptance(acceptance(), BUILD, PARK, 1001)

    def test_acceptance_refuses_every_stale_missing_identity(self):
        cases = [('sourceCommit', BUILD), ('version', '1.9.14'), ('schemaVersion', 24),
                 ('releaseAccepted', False), ('readOnlyEvidence', False), ('parkId', 'other'),
                 ('verifiedAtUnix', 99), ('verifiedAtUnix', 1002), ('verifiedAtUnix', True),
                 ('environmentSha256', ''), ('recoveryReceiptSha256', ''), ('releaseReceiptSha256', ''),
                 ('runtimeBuildCommit', 'short'), ('organizationId', '../escape'), ('helperSha256', {})]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                data = acceptance()
                data[key] = value
                with self.assertRaises(m.p.Refusal):
                    m.validate_acceptance(data, COMMIT, PARK, 1001)

    def test_active_definition_refuses_foreign_unit_dropins_and_restarts(self):
        for key, value in [('LoadState', 'not-found'), ('ActiveState', 'inactive'), ('SubState', 'exited'),
                ('Result', 'exit-code'), ('ExecMainStatus', '7'), ('MainPID', '0'), ('ControlPID', '13'),
                ('FragmentPath', '/tmp/test.service'), ('DropInPaths', '/tmp/override.conf'),
                ('ControlGroup', '/other.service'), ('KillMode', 'process'), ('User', 'root'),
                ('EnvironmentFiles', '/tmp/foreign.env'), ('InvocationID', ''), ('ExecStart', 'node')]:
            with self.subTest(key=key):
                state = active()
                state[key] = value
                with self.assertRaises(m.p.Refusal):
                    m.validate_active(state)

    def test_invocation_changes_detect_pid_reuse_or_restart(self):
        for key in ('MainPID', 'InvocationID', 'ExecMainStartTimestampMonotonic', 'NRestarts'):
            state = active()
            state[key] += '1'
            self.assertFalse(m.same_invocation(active(), state))

    def test_real_stop_method_uses_two_samples_and_80s_outer_deadline(self):
        h = m.ProductionHost(COMMIT, PARK, 'groups')
        state = active()
        state.update(ActiveState='inactive', MainPID='0', ControlGroup='')
        with (patch.object(m.p, 'run', return_value=b'') as run, patch.object(h, 'state', return_value=state) as read,
             patch.object(h, 'cgroup_empty', return_value=True) as group, patch.object(m.time, 'sleep')):
            h.stop(False)
            run.assert_called_once_with(['/usr/bin/systemctl', 'stop', 'otto-enterprise.service'], timeout=80)
            self.assertEqual(read.call_count, 2)
            self.assertEqual(group.call_count, 2)

    def test_real_stop_rejects_pid_descendant_dropin_and_stop_timeout(self):
        h = m.ProductionHost(COMMIT, PARK, 'groups')
        state = active()
        state.update(ActiveState='failed', MainPID='0', ControlGroup='', Result='exit-code', ExecMainStatus='7')
        with (patch.object(m.p, 'run', return_value=b''), patch.object(h, 'state', return_value=state),
             patch.object(h, 'cgroup_empty', return_value=True), patch.object(m.time, 'sleep')):
            h.stop(True)
            with self.assertRaises(m.p.Refusal):
                h.stop(False)
        with patch.object(m.p, 'run', side_effect=m.p.Refusal('timeout')), patch.object(h, 'state') as read:
            with self.assertRaises(m.p.Refusal):
                h.stop(True)
            read.assert_not_called()

    def test_main_refuses_nonlinux_before_host_operations(self):
        with (patch.object(m.sys, 'argv', ['activation', '--apply', '--expected-commit', COMMIT,
            '--verified-park-id', PARK, '--phase', 'requests']), patch.object(m.sys, 'platform', 'win32'),
            patch.object(m.p, 'locked') as locked):
            with self.assertRaises(m.p.Refusal):
                m.main()
            locked.assert_not_called()

    def test_health_identity_rejection_is_not_retried(self):
        h = m.ProductionHost(COMMIT, PARK, 'groups')
        h.started_invocation = active()
        with (patch.object(h, 'revalidate'), patch.object(h, 'check_loaded_environment'),
              patch.object(h, 'state', return_value=active()),
              patch.object(m.socket, 'create_connection'),
              patch.object(h, 'health', side_effect=m.p.Refusal('identity mismatch')) as health,
              patch.object(h, 'verify_park') as park):
            with self.assertRaises(m.p.Refusal):
                h.accept(NEW, True)
            health.assert_called_once()
            self.assertLessEqual(health.call_args.kwargs['timeout'], 40)
            park.assert_not_called()

    def test_elapsed_acceptance_budget_is_passed_to_health(self):
        h = m.ProductionHost(COMMIT, PARK, 'groups')
        h.started_invocation = active()
        with (patch.object(h, 'revalidate'), patch.object(h, 'check_loaded_environment'),
              patch.object(h, 'state', return_value=active()),
              patch.object(m.socket, 'create_connection'),
              patch.object(m.time, 'monotonic', side_effect=[100, 100, 105, 106, 151]),
              patch.object(h, 'health', side_effect=m.p.Refusal('fail once')) as health):
            with self.assertRaises(m.p.Refusal):
                h.accept(NEW, True)
            self.assertEqual(health.call_args.kwargs['timeout'], 9)

    def test_stdout_and_stderr_caps_apply_during_real_child_execution(self):
        for stream in ('stdout', 'stderr'):
            with self.subTest(stream=stream):
                start = time.monotonic()
                with self.assertRaises(m.p.Refusal) as error:
                    m.bounded_run([sys.executable, '-c',
                        "import sys,time;sys.%s.buffer.write(b'PRIVATE-DO-NOT-ECHO'*200000);sys.%s.flush();time.sleep(20)" % (stream, stream)], 3)
                self.assertLess(time.monotonic() - start, 4.5)
                self.assertNotIn('PRIVATE', str(error.exception))

    def test_real_child_timeout_is_bounded(self):
        start = time.monotonic()
        with self.assertRaises(m.p.Refusal):
            m.bounded_run([sys.executable, '-c', 'import time;time.sleep(20)'], 0.1)
        self.assertLess(time.monotonic() - start, 1.5)

    def test_trusted_read_rechecks_open_fd_metadata(self):
        with tempfile.TemporaryDirectory(dir=FILE.parent) as directory:
            file = Path(directory) / 'fixture.txt'
            file.write_bytes(b'not a secret')
            info = file.stat()
            changed = SimpleNamespace(**{name: getattr(info, name) for name in
                ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')})
            changed.st_size += 1
            with (patch.object(m.p, 'trusted_file', return_value=info),
                  patch.object(m.os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True),
                  patch.object(m.os, 'fstat', side_effect=[info, changed])):
                with self.assertRaises(m.p.Refusal):
                    m.trusted_read(file)

    def test_no_secret_or_business_endpoint_in_source(self):
        source = FILE.read_text()
        self.assertNotIn('OTTO_AMAP_WEB_SERVICE_KEY=', source)
        self.assertNotIn('ssh ', source)
        self.assertNotIn("'reboot'", source)
        self.assertNotIn("'kill'", source)
        self.assertNotIn('/enterprise/park-carpool', source)
        self.assertNotIn('print(values', source)


class SystemdFixtureCleanupTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('systemd_fixture', FILE.with_name('carpool-config-systemd-fixture.py'))
        self.harness = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.harness)

    def test_normal_inactive_unit_does_not_call_reset_failed(self):
        from unittest.mock import Mock
        run = Mock()
        self.harness.reset_failed_fixture(run, 'nonce-fixture.service', 'inactive')
        run.assert_not_called()

    def test_real_failed_unit_requires_successful_reset(self):
        from unittest.mock import Mock
        run = Mock()
        self.harness.reset_failed_fixture(run, 'nonce-fixture.service', 'failed')
        run.assert_called_once_with(['/usr/bin/systemctl', 'reset-failed', 'nonce-fixture.service'], 8)
        run.side_effect = self.harness.p.Refusal('fixture rejection')
        with self.assertRaises(self.harness.p.Refusal):
            self.harness.reset_failed_fixture(run, 'nonce-fixture.service', 'failed')

    def test_active_unknown_or_missing_state_cannot_be_cleanup_success(self):
        from unittest.mock import Mock
        for state in ('active', 'activating', 'deactivating', '', None, 'not-found'):
            with self.subTest(state=state):
                run = Mock()
                with self.assertRaises(self.harness.p.Refusal):
                    self.harness.reset_failed_fixture(run, 'nonce-fixture.service', state)
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
