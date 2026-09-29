"""Paths, exit codes and output shared by goal.py and check.py."""

import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]      # <root>/lib/taskcore/common.py
CONFIG_FILE = ROOT / "config.json"
TASKS_DIR = ROOT / "history"
ENV_FILE = TASKS_DIR / ".env"      # outside the skill folders, so sharing a skill never shares the key

EXIT_PASS, EXIT_BLOCK, EXIT_ESCALATE, EXIT_PRECONDITION = 0, 1, 2, 3


class Stop(Exception):
    """Raised by die() so tests can see the exit code and output without exiting."""

    def __init__(self, code, lines):
        super().__init__(code)
        self.code = code
        self.lines = list(lines)


def out(*lines):
    for line in lines:
        print(line)


def die(code, *lines):
    raise Stop(code, lines)


def run(main):
    """Script entry point: print a Stop's lines and exit with its code.

    A crash must never read as a verdict, so anything unexpected exits 2.
    """
    import traceback
    try:
        sys.exit(main())
    except Stop as stop:
        out(*stop.lines)
        sys.exit(stop.code)
    except SystemExit:
        raise
    except BaseException as err:
        out(f"ESCALATE: failed unexpectedly ({type(err).__name__}: {err}).",
            "Nothing was checked, reverted, or committed.",
            "",
            traceback.format_exc().rstrip())
        sys.exit(EXIT_ESCALATE)


def now():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def text_hash(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def read_stdin():
    if sys.stdin is None or sys.stdin.isatty():
        return ""
    return sys.stdin.read().strip()
