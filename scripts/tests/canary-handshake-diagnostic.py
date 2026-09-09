#!/usr/bin/env python3
"""Disposable-hosted fixture diagnostic only; never a release acceptance gate."""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys

BASE = '0dbbe7a8d165ac42770dda516fde8f0170ce9cfd'
PINS = {
    'scripts/tests/enterprise-canary-systemd-integration.py': 'f34ea5caa8ccb2165ac6ed7399233ef2aad6f7197d373db6d32f01cec30df2ac',
    'deployment/enterprise-oneclick/tools/canary-worker.mjs': '06470ce26094986f8496788de2b022eaf6d7a5b490e957a428ddaf1a425b7c47',
    'deployment/enterprise-oneclick/tools/health-check.mjs': 'c85716613a23ca301840a15b6b98858bf242fd2352aada46933aa253841dd490',
    'deployment/enterprise-oneclick/lib/common.sh': '528e521d321d788917c7ee10ea71a700e957b1dca5743ecff4d0a03a822e48e2',
}
WORKER = 'deployment/enterprise-oneclick/tools/canary-worker.mjs'
HARNESS = 'scripts/tests/enterprise-canary-systemd-integration.py'
MODES = ('original', 'observed', 'inject-go')
PHASES = (
    ('identity', 'async function worker() {'),
    ('credentials', '  const credentials = process.env.CREDENTIALS_DIRECTORY;'),
    ('environment', '  const env = runtimeEnvironment('),
    ('work-directory', '  fs.mkdirSync(`${VIEW}/work/tmp`, { mode: 0o700 });'),
    ('worker-ready', '  writeJson(`${VIEW}/work/worker-ready.json`, { nonce: config.nonce });'),
    ('go-wait', '  while (!fs.existsSync(`${VIEW}/control/go.json`)) {'),
    ('go-read', "  if (\n    JSON.parse(fs.readFileSync(`${VIEW}/control/go.json`, 'utf8')).nonce !=="),
    ('migration', '  const migration = startChild(['),
    ('runtime-start', '  runtime = startChild([`${VIEW}/package/release/run.mjs`]);'),
    ('ready-wait', '  while (!fs.existsSync(env.OTTO_ENTERPRISE_READY_FILE)) {'),
    ('ready-read', '  const ready = json(env.OTTO_ENTERPRISE_READY_FILE, process.getuid());'),
    ('health', '  await runHealthChecks({'),
    ('health-complete', '  writeJson(`${VIEW}/work/health-complete.json`, { nonce: config.nonce });'),
    ('stop-wait', '  while (!stopping) {'),
    ('runtime-exit', '  await runtimeExited;'),
    ('worker-result', '  writeJson(`${VIEW}/work/worker-result.json`, {'),
)
ERRNOS = ('EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'NONE', 'OTHER')
NAMES = ('Error', 'TypeError', 'SyntaxError', 'RangeError', 'OTHER')


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def replace_one(text, before, after):
    require(text.count(before) == 1, 'source-anchor-count-changed')
    return text.replace(before, after, 1)


def source_files(workspace, local=False):
    result = {}
    for relative, expected in PINS.items():
        file = workspace / relative
        require(file.is_file() and not file.is_symlink(), 'source-not-ordinary')
        raw = file.read_bytes()
        # Windows self-test only: Git checkout line endings are normalized.
        # Hosted execution checks the exact bytes, not a normalized hash.
        if local:
            raw = raw.replace(b'\r\n', b'\n')
        require(hashlib.sha256(raw).hexdigest() == expected, 'frozen-source-pin-mismatch')
        result[relative] = raw.decode('utf8')
    return result


def fixed_codes(worker):
    return sorted(set(re.findall(r"reject\('(canary-[a-z-]+)'\)", worker)) | {'canary-validation-failed'})


def instrument(worker, mode):
    require(mode in MODES, 'invalid-diagnostic-mode')
    if mode == 'original':
        return worker
    codes = fixed_codes(worker)
    result = replace_one(worker, 'let controlDeadline = Infinity;',
                         "let controlDeadline = Infinity;\nlet fixtureDiagnosticPhase = 'initialization';")
    for phase, anchor in PHASES:
        replacement = (anchor + f"\n  fixtureDiagnosticPhase = '{phase}';" if phase == 'identity'
                       else f"  fixtureDiagnosticPhase = '{phase}';\n" + anchor)
        result = replace_one(result, anchor, replacement)
    capture = '''
    // FIXTURE OBSERVATION ONLY: fixed enums, never message/stack/path/env.
    if (process.argv[2] === '_worker') {
      try {
        const diagnostic = {
          schema: 1,
          phase: FIXTURE_PHASES.includes(fixtureDiagnosticPhase) ? fixtureDiagnosticPhase : 'OTHER',
          errno: FIXTURE_ERRNOS.includes(error?.code) ? error.code : (error?.code === undefined ? 'NONE' : 'OTHER'),
          name: FIXTURE_NAMES.includes(error?.name) ? error.name : 'OTHER',
          code: FIXTURE_CODES.includes(error?.message) ? error.message : 'canary-validation-failed',
          injectedGoPermissionWindow: FIXTURE_INJECTED,
        };
        fs.writeFileSync(`${VIEW}/work/worker-failure.json`, JSON.stringify(diagnostic), {flag:'wx',mode:0o600});
      } catch { /* observation must not alter the original exit result */ }
    }
'''
    for key, value in {
        'FIXTURE_PHASES': ['initialization'] + [p for p, _ in PHASES],
        'FIXTURE_ERRNOS': list(ERRNOS), 'FIXTURE_NAMES': list(NAMES),
        'FIXTURE_CODES': codes, 'FIXTURE_INJECTED': mode == 'inject-go',
    }.items():
        capture = capture.replace(key, json.dumps(value))
    result = replace_one(result, '  main().catch((error) => {', '  main().catch((error) => {' + capture)
    if mode == 'inject-go':
        anchor = '        fs.chmodSync(`${transaction}/canary/control/go.json`, 0o444);'
        result = replace_one(result, anchor,
                             '        // FIXTURE FAULT INJECTION: visible root-only go.json for 500ms.\n'
                             '        await sleep(500);\n' + anchor)
    return result


def read_json(file, limit=32768):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and metadata.st_size <= limit, 'unsafe-evidence-file')
        raw = os.read(fd, limit + 1)
        require(len(raw) == metadata.st_size, 'evidence-read-changed')
        return json.loads(raw)
    finally:
        os.close(fd)


def validate_failure(value, mode, codes):
    require(isinstance(value, dict) and set(value) == {
        'schema', 'phase', 'errno', 'name', 'code', 'injectedGoPermissionWindow'}, 'unexpected-failure-fields')
    require(value['schema'] == 1 and value['phase'] in ['initialization'] + [p for p, _ in PHASES]
            and value['errno'] in ERRNOS and value['name'] in NAMES and value['code'] in codes
            and value['injectedGoPermissionWindow'] is (mode == 'inject-go'), 'unexpected-failure-enum')
    return value


def self_test(workspace):
    sources = source_files(workspace, local=True)
    original = sources[WORKER]
    require(instrument(original, 'original') == original, 'pure-mode-changed-source')
    observed = instrument(original, 'observed')
    injected = instrument(original, 'inject-go')
    require('await sleep(500)' not in observed and injected.count('await sleep(500)') == 1, 'injection-mode-mismatch')
    require("'StandardError=null'" in injected, 'stderr-isolation-changed')
    for changed in (observed, injected):
        for phase, _ in PHASES:
            require(changed.count(f"fixtureDiagnosticPhase = '{phase}'") == 1, 'phase-not-bound')
        require("if (process.argv[2] === '_worker') process.exit(5);" in changed, 'worker-exit-changed')
    try:
        instrument(original.replace('  const migration = startChild([', '  const migration = changed(['), 'observed')
        raise AssertionError('missing anchor accepted')
    except RuntimeError:
        pass
    valid = {'schema':1,'phase':'go-read','errno':'EACCES','name':'Error',
             'code':'canary-validation-failed','injectedGoPermissionWindow':True}
    validate_failure(valid, 'inject-go', fixed_codes(original))
    for bad in [dict(valid, message='private'), dict(valid, errno='SECRET'), dict(valid, phase='private-path'),
                dict(valid, injectedGoPermissionWindow=False), dict(valid, code='canary-secret-value')]:
        try:
            validate_failure(bad, 'inject-go', fixed_codes(original))
            raise AssertionError('unsafe diagnostic accepted')
        except RuntimeError:
            pass
    print(json.dumps({'offlineFacilityChecksPassed':True,'hostedExecution':False,
                      'productionAcceptance':False,'sourcePins':PINS}))


def execute(workspace, mode, work, evidence):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'linux-root-required')
    for key, value in {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted',
                       'RUNNER_OS':'Linux','OTTO_DISPOSABLE_SYSTEMD_ACCEPTANCE':'1'}.items():
        require(os.environ.get(key) == value, 'disposable-host-required')
    temporary = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    require(workspace == Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True)
            and workspace.is_relative_to('/home/runner/work'), 'unexpected-workspace')
    require(work.parent == temporary and work.name.startswith('otto-canary-') and not work.exists()
            and not work.is_symlink(), 'new-work-root-required')
    require(evidence.resolve(strict=True) == evidence and evidence.parent == temporary
            and evidence.name.startswith('otto-canary-evidence-') and evidence.is_dir()
            and not evidence.is_symlink(), 'bound-evidence-root-required')
    owner = evidence.stat()
    require(owner.st_uid == workspace.stat().st_uid, 'evidence-owner-mismatch')
    sources = source_files(workspace)
    worker = instrument(sources[WORKER], mode)
    # Only select the two existing positive fixture cases. All their assertions,
    # controller calls, cleanup and namespaces remain the existing harness's.
    modes = "['success']" if mode == 'inject-go' else "['success','drain45']"
    harness = replace_one(sources[HARNESS],
        "for mode in ['success','drain45','migration-exit7','runtime-exit7','oom','residual','hang-stop']:",
        f'for mode in {modes}:')
    copied_workers = []
    original_copy = shutil.copyfile

    def copy_fixture(source, destination, *args, **kwargs):
        result = original_copy(source, destination, *args, **kwargs)
        if Path(source) == workspace / WORKER:
            destination = Path(destination)
            require(destination.is_relative_to(work) and destination.parent.name == 'tools'
                    and destination.name == 'canary-worker.mjs' and not destination.is_symlink(), 'unexpected-copy-target')
            require(hashlib.sha256(destination.read_bytes()).hexdigest() == PINS[WORKER], 'copy-source-mismatch')
            if mode != 'original':
                destination.write_text(worker)
            copied_workers.append(hashlib.sha256(destination.read_bytes()).hexdigest())
        return result

    namespace = {'__name__':'fixture_harness', '__file__':str(workspace / HARNESS)}
    exec(compile(harness, str(workspace / HARNESS), 'exec'), namespace)
    harness_error = None
    argv = sys.argv
    try:
        shutil.copyfile = copy_fixture
        sys.argv = [str(workspace / HARNESS), '--work-dir', str(work), '--evidence-dir', str(evidence)]
        with contextlib.redirect_stdout(io.StringIO()):
            namespace['main']()
    except Exception as error:
        harness_error = type(error).__name__ if type(error).__name__ in ['RuntimeError','TimeoutExpired','AssertionError','ValueError','OSError'] else 'OTHER'
    finally:
        shutil.copyfile = original_copy
        sys.argv = argv
    require(source_files(workspace) == sources, 'original-source-mutated')
    receipt = read_json(evidence / 'receipt.json')
    observations = []
    for case in receipt.get('cases', []):
        require(case.get('mode') in ['success','drain45'], 'unexpected-case')
        directory = work / case['mode'] / 'txn' / 'canary' / 'work'
        failure_file = directory / 'worker-failure.json'
        failure = validate_failure(read_json(failure_file, 2048), mode, fixed_codes(sources[WORKER])) if failure_file.exists() else None
        observations.append({'mode':case['mode'],'controllerExit':case['exit'], 'seconds':case['seconds'],
            'workerFailure':failure, 'milestonesPresent':{name: (directory / name).is_file() for name in
                ['worker-ready.json','isolation-probe.json','canary-ready.json','health-complete.json','worker-result.json']}})
    identified = any(item['controllerExit'] == 5 and item['workerFailure'] is not None
                     and item['workerFailure']['phase'] == 'go-read'
                     and item['workerFailure']['errno'] == 'EACCES' for item in observations)
    success = (receipt.get('cleanupProven') is True and receipt.get('cleanupErrors') == []
               and (identified and harness_error is not None if mode == 'inject-go'
                    else receipt.get('passed') is True and harness_error is None))
    summary = {'diagnosticMode':mode,'fixtureOnly':True,'releaseAcceptance':False,
        'baseSource':BASE,'diagnosticCommit':os.environ['GITHUB_SHA'],'sourcePins':PINS,
        'workerCopyHashes':copied_workers,'injectedGoPermissionWindowMs':500 if mode == 'inject-go' else 0,
        'harnessErrorClass':harness_error,'observations':observations,'goEaccesObserved':identified,
        'cleanupProven':receipt.get('cleanupProven'),'diagnosticExpectationMet':success,
        'sourceFilesUnchanged':True}
    fd = os.open(evidence / 'diagnostic.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        raw = json.dumps(summary, indent=2).encode()
        require(len(raw) <= 32768, 'diagnostic-too-large')
        require(os.write(fd, raw) == len(raw), 'short-diagnostic-write')
        os.fchown(fd, owner.st_uid, owner.st_gid)
        os.fsync(fd)
    finally:
        os.close(fd)
    print(json.dumps(summary))
    return 0 if success else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--mode', choices=MODES)
    parser.add_argument('--work-dir')
    parser.add_argument('--evidence-dir')
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    if args.self_test:
        require(args.mode is None and args.work_dir is None and args.evidence_dir is None, 'self-test-arguments-invalid')
        self_test(workspace)
        return 0
    require(args.mode is not None and args.work_dir is not None and args.evidence_dir is not None, 'hosted-arguments-required')
    return execute(workspace, args.mode, Path(args.work_dir), Path(args.evidence_dir))


if __name__ == '__main__':
    sys.exit(main())
