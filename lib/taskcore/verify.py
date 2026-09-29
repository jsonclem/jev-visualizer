"""Verify commands. The exit code decides; Jev is never asked."""

import os
import signal
import subprocess
import time
from datetime import datetime

NOT_RUNNABLE = {126: "not executable", 127: "command not found"}


def shell(command, cwd, timeout):
    """(exit code or None on timeout, combined output). Kills the whole process
    group on timeout, so a test runner's children do not outlive it."""
    proc = subprocess.Popen(
        command, shell=True, cwd=cwd, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
    )
    try:
        output, _ = proc.communicate(timeout=timeout)
        return proc.returncode, output
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        output, _ = proc.communicate()
        return None, output


def run_check(check, root, log_dir, timeout, requires_timeout):
    """Run one Verify entry. States: passed, failed, couldnt_run.

    couldnt_run is kept apart from failed: a stopped database is not a failing test.
    """
    started = time.monotonic()
    result = {"command": check.command}

    def finish(state, reason, code, output, label):
        result.update(state=state, reason=reason, exit=code,
                      seconds=round(time.monotonic() - started, 1))
        if state != "passed":
            log_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            log = log_dir / f"{check.id}-{stamp}.log"
            log.write_text(f"$ {label}\n# exit: {code}\n# {reason}\n\n{output}")
            result["log"] = str(log)
        return result

    if check.requires:
        code, output = shell(check.requires, root, requires_timeout)
        if code is None:
            return finish("couldnt_run", f"Requires timed out after {requires_timeout}s",
                          None, output, check.requires)
        if code != 0:
            return finish("couldnt_run", f"Requires failed (exit {code}): {check.requires}",
                          code, output, check.requires)

    code, output = shell(check.command, root, timeout)
    if code is None:
        return finish("couldnt_run", f"timed out after {timeout}s", None, output, check.command)
    if code in NOT_RUNNABLE:
        return finish("couldnt_run", f"{NOT_RUNNABLE[code]} (exit {code})", code, output, check.command)
    if code != 0:
        return finish("failed", f"exit {code}", code, output, check.command)
    return finish("passed", "exit 0", 0, output, check.command)
