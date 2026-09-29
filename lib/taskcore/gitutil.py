"""Git facts. Plain code: nothing here asks Jev."""

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .common import EXIT_ESCALATE, EXIT_PRECONDITION, die


def git(root, *args, check=False, env=None):
    proc = subprocess.run(
        ["git"] + (["-C", str(root)] if root else []) + list(args),
        capture_output=True, text=True, env=env,
    )
    if check and proc.returncode != 0:
        die(EXIT_ESCALATE, f"ESCALATE: git {' '.join(args)} failed.", proc.stderr.strip())
    return proc.returncode, proc.stdout


def git_path(root, name):
    _, path = git(root, "rev-parse", "--git-path", name, check=True)
    path = Path(path.strip())
    return path if path.is_absolute() else root / path


def git_root():
    rc, root = git(None, "rev-parse", "--show-toplevel")
    if rc != 0 or not root.strip():
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: not inside a git repository.",
            "This skill requires git. The diff gate and the revert both depend on it.")
    return Path(root.strip())


def require_clean(root):
    _, status = git(root, "status", "--porcelain")
    if status.strip():
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: working tree is not clean.",
            "Commit or stash your own changes first. Nothing was modified.",
            "",
            status.rstrip())


def head_sha(root):
    rc, sha = git(root, "rev-parse", "--short", "HEAD")
    if rc != 0:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: repository has no commits.",
            "Make an initial commit first.")
    return sha.strip()


def head_tree(root):
    _, tree = git(root, "rev-parse", "HEAD^{tree}", check=True)
    return tree.strip()


def reachable(root, sha):
    rc, _ = git(root, "cat-file", "-e", f"{sha}^{{commit}}")
    return rc == 0


def snapshot(root):
    """Tree id of the working directory as it stands, untracked files included.

    Built in a throwaway index so the user's staging area is never touched. The
    gate, the commit and the pre-commit hook all compare this one fingerprint.
    """
    real_index = git_path(root, "index")
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp) / "index"
        if real_index.is_file():
            shutil.copyfile(real_index, scratch)
        env = {**os.environ, "GIT_INDEX_FILE": str(scratch)}
        git(root, "add", "-A", check=True, env=env)
        _, tree = git(root, "write-tree", check=True, env=env)
    return tree.strip()


def changed_paths(root, since, tree):
    """Every path added, changed or deleted. Renames count as both paths."""
    _, names = git(root, "diff", "--name-only", "--no-renames", since, tree, check=True)
    return [n for n in names.splitlines() if n.strip()]


def diff(root, since, tree, paths=None, context=0, function=False):
    """Unified diff, optionally limited to `paths`. None if git fails."""
    args = ["diff", "--no-color", "--no-ext-diff", "--no-renames"]
    args += ["--function-context"] if function else [f"-U{context}"]
    args += [since, tree]
    if paths is not None:
        args += ["--"] + [f":(literal){p}" for p in paths]
    rc, text = git(root, *args)
    return text if rc == 0 else None


def split_files(text):
    """[(path, text)] per file in a unified diff."""
    files = []
    for block in re.split(r"(?m)^(?=diff --git )", text):
        if not block.strip():
            continue
        header = block.splitlines()[0]
        match = re.match(r"diff --git a/.* b/(.*)$", header)
        files.append((match.group(1) if match else header, block))
    return files


def uses_conventional_commits(root):
    _, log = git(root, "log", "-20", "--pretty=%s")
    subjects = [s for s in log.splitlines() if s.strip()]
    if len(subjects) < 5:
        return False
    pattern = re.compile(r"^\w+(\([^)]*\))?!?: ")
    hits = sum(1 for s in subjects if pattern.match(s))
    return hits >= max(2, len(subjects) * 0.3)
