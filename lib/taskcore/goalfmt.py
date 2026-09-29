"""The goal format. Parsing and structure checks are plain code, never Jev.

    # <title>
    Repo: <repository folder name>
    <optional summary lines>

    ## Objectives
    ### O1 <optional short title>
    Files: <path or pattern>, <path or pattern>
    <what must be true when it is done>

    ## Rules
    - R1: <a limit on how the work is done>

    ## Out of scope
    - X1: <something not to change>

    ## Verify
    - V1: <shell command; exit 0 means pass>
      Requires: <optional shell command; nonzero means V1 couldn't run>

Objectives and Verify are required; Rules and Out of scope are optional.
Sections appear in this order, each at most once.
"""

import re
from dataclasses import asdict, dataclass, field

SECTIONS = ["objectives", "rules", "out of scope", "verify"]
PREFIX = {"objectives": "O", "rules": "R", "out of scope": "X", "verify": "V"}
TITLE = re.compile(r"^# (.*\S)\s*$")
REPO = re.compile(r"^Repo:\s*(.*?)\s*$")
SECTION = re.compile(r"^## (.*\S)\s*$")
OBJECTIVE = re.compile(r"^### (\S+)(?:\s+(.*\S))?\s*$")
ITEM = re.compile(r"^[-*]\s+(\S+?):\s*(.*?)\s*$")
FILES = re.compile(r"^Files:\s*(.*?)\s*$")
REQUIRES = re.compile(r"^Requires:\s*(.*?)\s*$")
ID = re.compile(r"^([A-Z])([1-9]\d*)$")


@dataclass
class Objective:
    id: str
    title: str
    files: list
    text: str

    def render(self):
        """The objective as Jev reads it, and as versions are compared."""
        head = f"{self.id}: {self.title}" if self.title else self.id
        return f"{head}\nFiles: {', '.join(self.files)}\n{self.text}"


@dataclass
class Item:
    id: str
    text: str


@dataclass
class Check:
    id: str
    command: str
    requires: str = ""


@dataclass
class Goal:
    title: str = ""
    repo: str = ""
    summary: str = ""
    objectives: list = field(default_factory=list)
    rules: list = field(default_factory=list)
    out_of_scope: list = field(default_factory=list)
    verify: list = field(default_factory=list)

    def ids(self):
        return [x.id for x in self.objectives + self.rules + self.out_of_scope + self.verify]

    def objective(self, oid):
        return next((o for o in self.objectives if o.id == oid), None)

    def to_dict(self):
        return asdict(self)


def unquote(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] == "`":
        return text[1:-1].strip()
    return text


def parse(text):
    """(Goal, [error]). Errors name the line, so the fix is obvious."""
    goal = Goal()
    errors = []
    summary = []
    section = None          # current section name
    seen = []               # sections in the order met
    current = None          # objective or item being filled
    body = []               # current objective's lines after Files:

    def close_objective():
        nonlocal current, body
        if isinstance(current, Objective):
            current.text = "\n".join(body).strip()
            if not current.text:
                errors.append(f"{current.id}: says nothing after its Files: line.")
        current, body = None, []

    def check_id(raw, where, n):
        prefix = PREFIX[where]
        match = ID.match(raw)
        if not match or match.group(1) != prefix:
            errors.append(f"line {n}: '{raw}' is not a valid ID here; "
                          f"{where.capitalize()} use {prefix}1, {prefix}2, ...")
            return False
        return True

    lines = text.splitlines()
    for n, raw in enumerate(lines, 1):
        line = raw.rstrip()

        if not goal.title and line.strip():
            match = TITLE.match(line)
            if match:
                goal.title = match.group(1)
                continue
            errors.append(f"line {n}: the goal must start with '# <title>'.")
            goal.title = "(missing)"

        if TITLE.match(line):
            errors.append(f"line {n}: only one '# ' title is allowed.")
            continue

        match = SECTION.match(line)
        if match:
            close_objective()
            name = match.group(1).strip().lower()
            if name not in SECTIONS:
                errors.append(f"line {n}: unknown section '## {match.group(1)}'. "
                              "Allowed: Objectives, Rules, Out of scope, Verify.")
                section = "unknown"
                continue
            if name in seen:
                errors.append(f"line {n}: '## {match.group(1)}' appears twice.")
            elif seen and SECTIONS.index(name) < SECTIONS.index(seen[-1]):
                errors.append(f"line {n}: '## {match.group(1)}' is out of order. "
                              "Order: Objectives, Rules, Out of scope, Verify.")
            seen.append(name)
            section = name
            continue

        if section is None:
            match = REPO.match(line)
            if match:
                if goal.repo:
                    errors.append(f"line {n}: 'Repo:' appears twice.")
                goal.repo = match.group(1)
            elif line.strip():
                summary.append(line.strip())
            continue

        if section == "unknown":
            continue

        if section == "objectives":
            match = OBJECTIVE.match(line)
            if match:
                close_objective()
                if check_id(match.group(1), section, n):
                    current = Objective(match.group(1), match.group(2) or "", [], "")
                    goal.objectives.append(current)
                else:
                    current = Objective("?", "", [], "")
                continue
            if line.startswith("###"):
                errors.append(f"line {n}: objectives start with '### O<number>'.")
                continue
            if current is None:
                if line.strip():
                    errors.append(f"line {n}: text in Objectives outside an objective. "
                                  "Start each objective with '### O<number>'.")
                continue
            if not current.files and not body:
                if not line.strip():
                    continue
                match = FILES.match(line.strip())
                if not match:
                    errors.append(f"{current.id}: the first line must be 'Files: <paths>'.")
                    current.files = ["(missing)"]
                    body.append(line)
                    continue
                current.files = [unquote(f) for f in match.group(1).split(",") if f.strip()]
                if not current.files:
                    errors.append(f"{current.id}: 'Files:' lists no files.")
                    current.files = ["(missing)"]
                for pattern in current.files:
                    problem = bad_pattern(pattern)
                    if problem:
                        errors.append(f"{current.id}: file '{pattern}' {problem}.")
                continue
            body.append(line)
            continue

        # Rules, Out of scope, Verify: bulleted items with IDs.
        if not line.strip():
            continue
        if line.startswith("#"):
            errors.append(f"line {n}: headings are not allowed inside {section.capitalize()}.")
            continue
        match = ITEM.match(line)
        if match:
            if not check_id(match.group(1), section, n):
                current = None
                continue
            content = match.group(2)
            if section == "verify":
                current = Check(match.group(1), unquote(content))
                goal.verify.append(current)
                if not current.command:
                    errors.append(f"{current.id}: has no command.")
            else:
                current = Item(match.group(1), content)
                (goal.rules if section == "rules" else goal.out_of_scope).append(current)
            continue
        if raw[:1] in (" ", "\t") and current is not None:
            if isinstance(current, Check):
                req = REQUIRES.match(line.strip())
                if req and not current.requires:
                    current.requires = unquote(req.group(1))
                else:
                    errors.append(f"{current.id}: only one indented 'Requires: <command>' "
                                  "line may follow a Verify command.")
            else:
                current.text = f"{current.text} {line.strip()}".strip()
            continue
        errors.append(f"line {n}: {section.capitalize()} holds only '- {PREFIX[section]}<number>: ...' items.")

    close_objective()
    goal.summary = "\n".join(summary)

    if not goal.title:
        errors.append("the goal is empty.")
    if not goal.repo:
        errors.append("missing 'Repo: <repository folder name>' under the title.")
    if not goal.objectives:
        errors.append("no objectives. Add '## Objectives' with at least one '### O1'.")
    if not goal.verify:
        errors.append("no Verify commands. Add '## Verify' with at least one '- V1: <command>'.")
    for item in goal.rules + goal.out_of_scope:
        if not item.text:
            errors.append(f"{item.id}: is empty.")
    seen_ids = set()
    for oid in goal.ids():
        if oid in seen_ids:
            errors.append(f"{oid}: used more than once.")
        seen_ids.add(oid)
    return goal, errors


def bad_pattern(pattern):
    if pattern.startswith("/"):
        return "must be relative to the repository root"
    if ".." in pattern.split("/"):
        return "must not contain '..'"
    return None


def glob_regex(pattern):
    """Patterns: '*' within one folder, '**' across folders, '?' one character.
    A pattern with no wildcard also matches everything under it as a folder."""
    if pattern.endswith("/"):
        pattern += "**"
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    if not any(c in pattern for c in "*?"):
        out.append("(?:/.*)?")
    return re.compile("^" + "".join(out) + "$")


def matches(pattern, path):
    return bool(glob_regex(pattern).match(path))


def owners(goal, path):
    """Objectives whose Files cover `path`."""
    return [o for o in goal.objectives if any(matches(p, path) for p in o.files)]


def uncovered(goal, paths):
    return [p for p in paths if not owners(goal, p)]


def compare(old, new):
    """What changed between two goal versions, by ID."""
    changes = []
    for label, a, b in (("title", old.title, new.title), ("Repo", old.repo, new.repo),
                        ("summary", old.summary, new.summary)):
        if a != b:
            changes.append(f"{label} changed")

    def keyed(goal):
        return {**{o.id: o.render() for o in goal.objectives},
                **{i.id: i.text for i in goal.rules + goal.out_of_scope},
                **{c.id: f"{c.command}\n{c.requires}" for c in goal.verify}}

    a, b = keyed(old), keyed(new)
    for oid in b:
        if oid not in a:
            changes.append(f"{oid} added")
        elif a[oid] != b[oid]:
            changes.append(f"{oid} changed")
    for oid in a:
        if oid not in b:
            changes.append(f"{oid} removed")
    return changes


def from_dict(data):
    return Goal(
        title=data["title"], repo=data["repo"], summary=data.get("summary", ""),
        objectives=[Objective(**o) for o in data["objectives"]],
        rules=[Item(**i) for i in data["rules"]],
        out_of_scope=[Item(**i) for i in data["out_of_scope"]],
        verify=[Check(**c) for c in data["verify"]],
    )
