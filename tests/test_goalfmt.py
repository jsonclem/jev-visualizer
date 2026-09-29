import unittest

from support import GOAL  # noqa: F401  (also puts lib on sys.path)
from taskcore import goalfmt


RULES = "## Rules\n- R1: Keep each file to one line.\n\n"


def errors_of(text):
    return goalfmt.parse(text)[1]


class ParseTest(unittest.TestCase):
    def test_valid_goal(self):
        goal, errors = goalfmt.parse(GOAL)
        self.assertEqual(errors, [])
        self.assertEqual(goal.title, "Demo task")
        self.assertEqual(goal.repo, "demo")
        self.assertEqual(goal.summary, "A small task for tests.")
        self.assertEqual([o.id for o in goal.objectives], ["O1", "O2"])
        self.assertEqual(goal.objectives[0].title, "First file")
        self.assertEqual(goal.objectives[1].files, ["b.txt", "docs/"])
        self.assertEqual(goal.objectives[1].text, "b.txt says DONE.")
        self.assertEqual([r.id for r in goal.rules], ["R1"])
        self.assertEqual([x.id for x in goal.out_of_scope], ["X1"])
        self.assertEqual(goal.verify[0].command, "grep -q DONE a.txt && grep -q DONE b.txt")

    def test_requires_and_backticks(self):
        text = GOAL.replace("- V1: grep -q DONE a.txt && grep -q DONE b.txt",
                            "- V1: `npm test`\n  Requires: `test -d node_modules`")
        goal, errors = goalfmt.parse(text)
        self.assertEqual(errors, [])
        self.assertEqual(goal.verify[0].command, "npm test")
        self.assertEqual(goal.verify[0].requires, "test -d node_modules")

    def test_multiline_objective_and_rule_continuation(self):
        text = GOAL.replace("a.txt says DONE.", "a.txt says DONE.\n\n- and nothing else").replace(
            "- R1: Keep each file to one line.", "- R1: Keep each file\n  to one line.")
        goal, errors = goalfmt.parse(text)
        self.assertEqual(errors, [])
        self.assertEqual(goal.objectives[0].text, "a.txt says DONE.\n\n- and nothing else")
        self.assertEqual(goal.rules[0].text, "Keep each file to one line.")

    def test_structure_errors(self):
        cases = {
            "must start with '# <title>'": GOAL.replace("# Demo task\n", ""),
            "missing 'Repo:": GOAL.replace("Repo: demo\n", ""),
            "first line must be 'Files:": GOAL.replace("Files: a.txt\n", ""),
            "used more than once": GOAL.replace("### O2", "### O1"),
            "not a valid ID here": GOAL.replace("- R1:", "- O9:"),
            "unknown section": GOAL.replace("## Rules", "## Notes"),
            "out of order": GOAL.replace(RULES, "") + "\n" + RULES,
            "outside an objective": GOAL.replace("## Objectives\n", "## Objectives\nstray text\n"),
            "no Verify commands": GOAL.split("## Verify")[0],
            "says nothing after its Files": GOAL.replace("a.txt says DONE.\n", ""),
            "must be relative": GOAL.replace("Files: a.txt", "Files: /etc/passwd"),
            "must not contain '..'": GOAL.replace("Files: a.txt", "Files: ../x"),
            "only one indented 'Requires": GOAL.replace(
                "grep -q DONE b.txt", "grep -q DONE b.txt\n  Also: x"),
            "holds only '- R<number>": GOAL.replace("- R1: Keep", "R1 Keep"),
        }
        for expected, text in cases.items():
            with self.subTest(expected):
                errors = errors_of(text)
                self.assertTrue(any(expected in e for e in errors), errors)

    def test_render_includes_files(self):
        goal, _ = goalfmt.parse(GOAL)
        self.assertEqual(goal.objectives[0].render(), "O1: First file\nFiles: a.txt\na.txt says DONE.")


class MatchTest(unittest.TestCase):
    def test_patterns(self):
        cases = [
            ("a.txt", "a.txt", True),
            ("a.txt", "b/a.txt", False),
            ("src/features/demo", "src/features/demo/index.tsx", True),
            ("src/features/demo", "src/features/demo2/index.tsx", False),
            ("docs/", "docs/a/b.md", True),
            ("src/*.ts", "src/a.ts", True),
            ("src/*.ts", "src/x/a.ts", False),
            ("src/**/*.ts", "src/a.ts", True),
            ("src/**/*.ts", "src/x/y/a.ts", True),
            ("src/**", "src/x/y", True),
            ("a?.txt", "ab.txt", True),
            ("a?.txt", "a/.txt", False),
            ("a+b.txt", "a+b.txt", True),
        ]
        for pattern, path, expected in cases:
            with self.subTest(pattern=pattern, path=path):
                self.assertEqual(goalfmt.matches(pattern, path), expected)

    def test_owners_and_uncovered(self):
        goal, _ = goalfmt.parse(GOAL)
        self.assertEqual([o.id for o in goalfmt.owners(goal, "docs/x.md")], ["O2"])
        self.assertEqual(goalfmt.uncovered(goal, ["a.txt", "README.md", "docs/y"]), ["README.md"])


class CompareTest(unittest.TestCase):
    def test_changes_by_id(self):
        old, _ = goalfmt.parse(GOAL)
        new_text = (GOAL.replace("b.txt says DONE.", "b.txt says DONE twice.")
                        .replace("### O1 First file\nFiles: a.txt\na.txt says DONE.\n\n", "")
                        .replace("## Rules", "### O3\nFiles: c.txt\nc.txt exists.\n\n## Rules")
                        .replace("# Demo task", "# Demo task 2"))
        new, errors = goalfmt.parse(new_text)
        self.assertEqual(errors, [])
        self.assertEqual(goalfmt.compare(old, new), ["title changed", "O2 changed", "O3 added", "O1 removed"])

    def test_no_changes(self):
        old, _ = goalfmt.parse(GOAL)
        self.assertEqual(goalfmt.compare(old, old), [])


if __name__ == "__main__":
    unittest.main()
