#!/usr/bin/env python3
"""Real systemd/cgroup-v2 acceptance; disposable GitHub-hosted Ubuntu ONLY.

No dependencies, network, production paths, reboot, or gateway invocation.
The service identity is fixed because the production guard deliberately pins
system.slice/otto-enterprise.service. Its absence is checked before ownership.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

UNIT = "otto-enterprise.service"
UNIT_FILE = Path("/run/systemd/system") / UNIT
CGROUP = Path("/sys/fs/cgroup/system.slice") / UNIT
OWNED_PREFIX = "otto-systemd-acceptance-"
SERVICE_VIEW = "/run/otto-compensation-fixture"
SERVICE_SOURCE = r'''import os, pathlib, signal, sys, time
mode, directory = sys.argv[1:]
directory = pathlib.Path(directory)
status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert os.geteuid() == 0 and status['NoNewPrivs'].strip() == '1'
assert all(int(status[name].strip(), 16) == 0 for name in ['CapEff', 'CapPrm', 'CapBnd', 'CapAmb'])
assert str(directory) == '/run/otto-compensation-fixture/work'
(directory / 'isolation-probe').write_text('root-cap0-nnp1-bound-view')
if mode == 'exit7':
    sys.exit(7)
if mode == 'residual':
    child = os.fork()
    if child == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        (directory / 'child.pid').write_text(str(os.getpid()))
        time.sleep(40)
        os._exit(0)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
else:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
(directory / 'service.ready').write_text(str(os.getpid()))
# Even if test cleanup itself fails, this fixture process has a finite life.
end = time.monotonic() + 110
while time.monotonic() < end:
    time.sleep(0.1)
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def service_unit(case, mode, run_id):
    """Keep runner-owned private ancestors closed; systemd binds before cap drop."""
    require(mode in {'exit7', 'residual', 'timeout'} and re.fullmatch(r'[1-9][0-9]*', run_id),
            'invalid service fixture identity')
    require(case.is_absolute() and re.fullmatch(r'/[A-Za-z0-9_./-]+', str(case)),
            'invalid service fixture path')
    return f"""# Owned only by disposable Otto test {run_id}
[Unit]
Description=Disposable Otto compensation regression
[Service]
Type=exec
ExecStart=/usr/bin/python3 -I -S {SERVICE_VIEW}/service.py {mode} {SERVICE_VIEW}/work
Restart=no
KillMode={'process' if mode == 'residual' else 'control-group'}
TimeoutStopSec={'120' if mode == 'timeout' else '5'}
SendSIGKILL={'no' if mode == 'timeout' else 'yes'}
RuntimeMaxSec=150
MemoryMax=64M
CPUQuota=10%
TasksMax=8
PrivateNetwork=yes
ProtectSystem=strict
ProtectHome=yes
TemporaryFileSystem=/run:ro
BindReadOnlyPaths={case}/service.py:{SERVICE_VIEW}/service.py
BindPaths={case}/service-work:{SERVICE_VIEW}/work
ReadWritePaths={SERVICE_VIEW}/work
WorkingDirectory={SERVICE_VIEW}/work
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
"""


def run(argv, *, timeout=10, check=True, input_text=None):
    result = subprocess.run(argv, input=input_text, text=True, capture_output=True,
                            timeout=timeout, env=os.environ.copy())
    if check and result.returncode:
        raise RuntimeError(f"command failed: {Path(argv[0]).name} ({result.returncode})")
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def state():
    result = run(["/usr/bin/systemctl", "show", UNIT,
                  "--property=LoadState", "--property=FragmentPath", "--property=ActiveState",
                  "--property=MainPID", "--property=ControlGroup", "--property=Result",
                  "--property=ExecMainStatus", "--property=DropInPaths"], check=False)
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    fields["showExitCode"] = result.returncode
    return fields


def group_state():
    if not CGROUP.exists():
        require(not CGROUP.is_symlink(), "unexpected cgroup symlink")
        return {"exists": False, "populated": "0", "pids": []}
    require(CGROUP.is_dir() and not CGROUP.is_symlink(), "unsafe test cgroup")
    fields = dict(line.split() for line in (CGROUP / "cgroup.events").read_text().splitlines())
    return {"exists": True, "populated": fields.get("populated"),
            "pids": [int(value) for value in (CGROUP / "cgroup.procs").read_text().split()]}


def wait_until(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise RuntimeError("bounded test condition did not become true")


def hosted_context():
    require(sys.platform == "linux" and os.geteuid() == 0, "Linux root required")
    require(os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and os.environ.get("RUNNER_OS") == "Linux"
            and os.environ.get("OTTO_DISPOSABLE_SYSTEMD_ACCEPTANCE") == "1",
            "refusing outside explicit disposable GitHub-hosted acceptance")
    require(not Path("/.dockerenv").exists(), "container is not real hosted systemd acceptance")
    require(Path("/proc/1/comm").read_text().strip() == "systemd", "PID 1 must be systemd")
    require(os.readlink("/proc/self/ns/net") != os.readlink("/proc/1/ns/net"),
            "harness needs an isolated network namespace")
    require({name for _, name in socket.if_nameindex()} <= {"lo"}, "unexpected network interface")
    require(run(["/usr/bin/stat", "-f", "-c", "%T", "/sys/fs/cgroup"]).stdout.strip() == "cgroup2fs",
            "real unified cgroup v2 required")
    require(re.fullmatch(r"[1-9][0-9]*", os.environ.get("GITHUB_RUN_ID", "")), "invalid run id")
    require(re.fullmatch(r"[1-9][0-9]*", os.environ.get("GITHUB_RUN_ATTEMPT", "")), "invalid attempt")
    require(re.fullmatch(r"[0-9a-f]{40}", os.environ.get("GITHUB_SHA", "")), "invalid source identity")
    workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True)
    temporary = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    require(workspace.is_relative_to("/home/runner/work") and temporary.is_relative_to("/home/runner/work"),
            "unexpected GitHub hosted workspace paths")
    return workspace, temporary


def restoration_arguments(fixture, command, arguments):
    """Accept only the exact cleanup command grammar, never arbitrary options."""
    if command == "install":
        require(len(arguments) == 8 and arguments[:1] == ["-o"]
                and arguments[2:3] == ["-g"] and arguments[4:5] == ["-m"]
                and arguments[1] == arguments[3] and arguments[1] in {"root", "otto-enterprise"}
                and arguments[5] in {"0600", "0644"}, "unexpected fixture install options")
        options, operands = ["-o", "root", "-g", "root", "-m", arguments[5]], arguments[6:]
    else:
        count = 1 if command == "rm" else 2
        options, operands = arguments[:-count], arguments[-count:]
        allowed = {"ln": [["-sfn"]], "mv": [[], ["-Tf"]],
                   "cp": [["-a"]], "rm": [["-f"], ["-rf"]]}
        require(command in allowed and options in allowed[command] and len(operands) == count,
                "unexpected fixture restoration command or options")
    for value in operands:
        path = Path(value)
        require(path.is_absolute() and path.resolve().is_relative_to(fixture)
                and path.resolve() != fixture, "restoration operand escaped fixture")
    return options + operands


def fixture_command():
    """Real filesystem mutations, confined to one already-created fixture."""
    _, temporary = hosted_context()
    fixture = Path(sys.argv[2]).resolve(strict=True)
    require(fixture.parent.parent == temporary and fixture.parent.name.startswith(OWNED_PREFIX)
            and re.fullmatch(r"case-[a-z0-9-]+", fixture.name), "unbound restoration fixture")
    ledger = fixture.parent / "owned.json"
    require(ledger.is_file() and not ledger.is_symlink(), "missing fixture ownership ledger")
    require(json.loads(ledger.read_text()) == {"run": os.environ["GITHUB_RUN_ID"],
                                              "source": os.environ["GITHUB_SHA"]}, "fixture ownership changed")
    command, *arguments = sys.argv[3:]
    arguments = restoration_arguments(fixture, command, arguments)
    with (fixture / "mutations.log").open("a") as log:
        log.write(command + "\n")
    return run([f"/usr/bin/{command}", *arguments], check=False).returncode


class Acceptance:
    def __init__(self, workspace, temporary, report):
        self.workspace, self.temporary, self.report = workspace, temporary, report
        self.root = Path(tempfile.mkdtemp(prefix=OWNED_PREFIX, dir=temporary))
        self.root.chmod(0o700)
        (self.root / "owned.json").write_text(json.dumps({"run": os.environ["GITHUB_RUN_ID"],
                                                       "source": os.environ["GITHUB_SHA"]}))
        self.unit_digest = None
        source_path = workspace / "deployment/enterprise-oneclick/upgrade.sh"
        source = source_path.read_text()
        start = source.index("otto_read_compensation_service_state() {")
        end = source.index("\ntrap cleanup EXIT", start)
        self.logic = source[start:end]
        require("otto_prove_compensation_stopped" in self.logic, "missing current compensation logic")
        self.report["upgradeSha256"] = digest(source_path)

    def preflight(self):
        for path in [Path("/opt/otto-enterprise"), Path("/etc/otto-enterprise"), Path("/var/lib/otto-enterprise"),
                     Path("/etc/systemd/system") / UNIT, UNIT_FILE,
                     Path("/lib/systemd/system") / UNIT, Path("/usr/lib/systemd/system") / UNIT,
                     Path("/etc/systemd/system") / (UNIT + ".d"),
                     Path("/run/systemd/system") / (UNIT + ".d"),
                     Path("/lib/systemd/system") / (UNIT + ".d"),
                     Path("/usr/lib/systemd/system") / (UNIT + ".d")]:
            require(not path.exists() and not path.is_symlink(), "existing service or production path; refusing")
        require(not CGROUP.exists() and not CGROUP.is_symlink(), "pre-existing test cgroup; refusing")
        observed = state()
        require(observed.get("LoadState") == "not-found" and not observed.get("FragmentPath")
                and not observed.get("DropInPaths")
                and observed.get("MainPID") == "0", "pre-existing service identity; refusing")
        self.report["preflight"] = observed

    def create_service(self, case, mode):
        require(self.unit_digest is None and not UNIT_FILE.exists(), "test service already owned")
        script = case / "service.py"
        script.write_text(SERVICE_SOURCE)
        script.chmod(0o600)
        service_work = case / "service-work"
        service_work.mkdir(mode=0o700)
        content = service_unit(case, mode, os.environ['GITHUB_RUN_ID'])
        with UNIT_FILE.open("x") as handle:
            handle.write(content)
        UNIT_FILE.chmod(0o644)
        self.unit_digest = digest(UNIT_FILE)
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "start", UNIT], check=False)
        if mode == "exit7":
            wait_until(lambda: state().get("ActiveState") == "failed")
            require(state().get("ExecMainStatus") == "7", "fixture did not actually exit 7")
        else:
            wait_until(lambda: (service_work / "service.ready").is_file())
            if mode == "residual":
                wait_until(lambda: (service_work / "child.pid").is_file())
                run(["/usr/bin/systemctl", "stop", UNIT])
                require(state().get("MainPID") == "0" and group_state()["populated"] == "1",
                        "real residual-process precondition was not reached")
        require((service_work / 'isolation-probe').read_text() == 'root-cap0-nnp1-bound-view'
                and self.root.stat().st_mode & 0o777 == 0o700, 'service isolation or private ancestor changed')

    def cleanup_service(self):
        if self.unit_digest is None:
            return
        require(UNIT_FILE.is_file() and not UNIT_FILE.is_symlink()
                and digest(UNIT_FILE) == self.unit_digest
                and state().get("FragmentPath") == str(UNIT_FILE), "test service custody changed; refusing cleanup")
        run(["/usr/bin/systemctl", "kill", "--signal=KILL", UNIT], check=False)
        run(["/usr/bin/systemctl", "stop", UNIT], timeout=15, check=False)
        wait_until(lambda: state().get("MainPID") == "0" and group_state()["populated"] == "0")
        UNIT_FILE.unlink()
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "reset-failed", UNIT], check=False)
        require(state().get("LoadState") == "not-found", "owned unit was not removed")
        self.unit_digest = None

    def exercise(self, name, mode=None, success=False):
        case = self.root / ("case-" + name)
        case.mkdir()
        for directory in ["txn/deploy.before", "install/deploy", "releases/old", "releases/new", "data"]:
            (case / directory).mkdir(parents=True, exist_ok=True)
        for filename in ["data.db", "resident-recurring-tasks.json", "enterprise.env", "otto-enterprise.service"]:
            (case / "txn" / (filename + ".before")).write_text("old-" + filename)
        (case / "data/data.db").write_text("candidate-database")
        (case / "managed.key").write_text("synthetic-candidate-key")
        (case / "enterprise.env").write_text("synthetic-candidate-env")
        (case / "service-unit").write_text("synthetic-candidate-unit")
        verifier = case / "install/deploy/verify.sh"
        verifier.write_text("#!/bin/bash\nexit 0\n")
        verifier.chmod(0o755)
        shutil.copy2(verifier, case / "txn/deploy.before/verify.sh")
        (case / "install/current").symlink_to(case / "releases/new", target_is_directory=True)
        def business_snapshot():
            paths = [case / name for name in ["enterprise.env", "service-unit", "managed.key"]]
            paths += list((case / "data").rglob("*")) + list((case / "install").rglob("*"))
            return {str(path.relative_to(case)): ("link:" + os.readlink(path) if path.is_symlink()
                    else digest(path)) for path in paths if path.is_symlink() or path.is_file()}

        before_bytes = business_snapshot()
        receipt = {"name": name, "passed": False}
        self.report["cases"].append(receipt)
        try:
            if mode:
                self.create_service(case, mode)
            receipt["before"] = state()
            receipt["cgroupBefore"] = group_state()
            script = f"""set -Eeuo pipefail
cd '{case}'
TXN_DIR="$PWD/txn"; INSTALL_ROOT="$PWD/install"; DATA_DIR="$PWD/data"
CURRENT_REAL="$PWD/releases/old"; CONFIG_PATH="$PWD/enterprise.env"; SERVICE_UNIT="$PWD/service-unit"
OLD_DATA_BACKUP="$TXN_DIR/data.db.before"; OLD_DEPLOY_BACKUP="$TXN_DIR/deploy.before"
CONFIG_BACKUP="$TXN_DIR/enterprise.env.before"; SERVICE_UNIT_BACKUP="$TXN_DIR/otto-enterprise.service.before"
RESIDENT_STATE_PATH="$DATA_DIR/resident-recurring-tasks.json"
OLD_RESIDENT_STATE_BACKUP="$TXN_DIR/resident-recurring-tasks.json.before"
OLD_RESIDENT_STATE_ABSENT="$TXN_DIR/resident-recurring-tasks.absent"
MANAGED_DATABASE_KEY_PATH="$PWD/managed.key"
ROLLBACK_DIR="$TXN_DIR"; CANARY_PID=''; CANARY_STARTED=0; TARGET_RELEASE_STAGE=''
DRY_RUN=0; ROLLBACK_NEEDED=1; UPGRADE_SUCCEEDED=0; SERVICE_STOPPED=1
RESIDENT_STATE_EXISTED=1; DATABASE_KEY_CREATED=1; OTTO_ALLOW_SMS_DISABLED=0
fixture_command() {{ /usr/bin/python3 -I -S '{Path(__file__).resolve()}' --fixture-command '{case}' "$@"; }}
install() {{ fixture_command install "$@"; }}
ln() {{ fixture_command ln "$@"; }}
mv() {{ fixture_command mv "$@"; }}
cp() {{ fixture_command cp "$@"; }}
rm() {{ fixture_command rm "$@"; }}
systemctl() {{
  case "$1" in
    stop|show) [ "$2" = otto-enterprise ] || return 99; /usr/bin/systemctl "$@" ;;
    start|daemon-reload) printf '%s\\n' "$1" >> "$PWD/restore-service-intent.log" ;;
    *) return 99 ;;
  esac
}}
otto_warn() {{ printf '%s\\n' "$*" >&2; }}
otto_log() {{ printf '%s\\n' "$*"; }}
sync_live_deployment_filesystems() {{ /usr/bin/sync -f "$PWD"; }}
write_rollback_verified_witness() {{ printf verified > "$PWD/rollback-witness"; }}
{self.logic}
cleanup
"""
            started = time.monotonic()
            result = run(["/bin/bash"], input_text=script, timeout=105, check=False)
            receipt.update(exitCode=result.returncode, seconds=round(time.monotonic() - started, 3),
                           after=state(), cgroupAfter=group_state())
            receipt["diagnostic"] = result.stderr[-2000:]
            if success:
                require(result.returncode == 0, "stopped exit-7 candidate was not restored")
                require((case / "data/data.db").read_text() == "old-data.db"
                        and (case / "rollback-witness").is_file(), "fixture restoration was incomplete")
                require((case / "enterprise.env").read_text() == "old-enterprise.env"
                        and (case / "service-unit").read_text() == "old-otto-enterprise.service"
                        and not (case / "managed.key").exists()
                        and (case / "install/current").resolve() == case / "releases/old",
                        "fixture identity, environment or key restoration was incomplete")
            else:
                require(result.returncode != 0, "unsafe or unknown service was accepted")
                require(not (case / "mutations.log").exists()
                        and not (case / "restore-service-intent.log").exists()
                        and not (case / "rollback-witness").exists(), "restoration began before stop proof")
                require((case / "data/data.db").read_text() == "candidate-database"
                        and (case / "txn/recovery-required").is_file(), "recovery evidence or unchanged bytes missing")
                require(business_snapshot() == before_bytes, "business fixture changed before stop proof")
            if mode == "timeout":
                require(75 <= receipt["seconds"] < 100, "real stop deadline was not exercised")
                require(group_state()["populated"] == "1", "timeout candidate was no longer alive")
            receipt["passed"] = True
        finally:
            try:
                receipt["finalServiceState"] = state()
                receipt["finalCgroupState"] = group_state()
                # This sole owned unit contains synthetic fixtures, never
                # production data. Retain bounded systemd setup diagnostics.
                receipt["unitJournal"] = run(["/usr/bin/journalctl", "--unit", UNIT,
                    "--no-pager", "--output=cat", "--lines=12"], check=False).stdout[-4000:]
            finally:
                self.cleanup_service()


def main():
    workspace, temporary = hosted_context()
    if len(sys.argv) > 1:
        require(sys.argv[1] == "--fixture-command", "unknown harness operation")
        return fixture_command()
    evidence = temporary / f"otto-systemd-evidence-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    # The workflow writes a failure placeholder before privileged preflight,
    # so even refusal before this point has a retained artifact.
    require(evidence.is_dir() and not evidence.is_symlink()
            and evidence.resolve().parent == temporary, "missing or unsafe evidence directory")
    report = {"format": "otto-real-systemd-compensation-v1", "sourceCommit": os.environ["GITHUB_SHA"],
              "cases": [], "passed": False, "cleanupPassed": False}
    acceptance = None
    try:
        acceptance = Acceptance(workspace, temporary, report)
        acceptance.preflight()
        acceptance.exercise("stopped-exit7", "exit7", success=True)
        acceptance.exercise("residual-child", "residual")
        acceptance.exercise("real-stop-timeout", "timeout")
        # Deliberately NOT a fake stdout: an actually absent systemd unit may
        # report inactive/MainPID=0. The real stop command must still refuse it.
        acceptance.exercise("unknown-unit")
        report["passed"] = True
    except Exception as error:
        report["errorType"] = type(error).__name__
        report["error"] = str(error)[:1000]
    finally:
        try:
            if acceptance:
                acceptance.cleanup_service()
                require(acceptance.root.parent == temporary and acceptance.root.name.startswith(OWNED_PREFIX),
                        "temporary cleanup target changed")
                require(not acceptance.root.is_symlink(), "temporary cleanup target became a symlink")
                shutil.rmtree(acceptance.root)
            report["cleanupPassed"] = True
        except Exception as error:
            report["cleanupError"] = str(error)[:1000]
        report["passed"] = report["passed"] and report["cleanupPassed"]
        receipt = evidence / "receipt.json"
        receipt.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        receipt.chmod(0o644)
        print(json.dumps({"passed": report["passed"], "cases": len(report["cases"]), "receipt": str(receipt)}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
