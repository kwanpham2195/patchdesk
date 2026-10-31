# Review checks

Narrow checks for final verification. Each file asks one question set about one rule family, so a reviewer applies it evenly and cheaply instead of running one broad pass.

Files: `test-signal.md`, `ui-consistency.md`, `needs-maintainer.md`, `write-safety.md`.

Each check has frontmatter with `include` and `exclude` globs, a question list, and a reply format:

- Nothing found: reply exactly `All clear`.
- Otherwise: one line per finding, `file:line — problem — minimal fix`. No other prose.

Final verification, after live checks pass:

1. List changed paths against the base branch.
2. Select every check where at least one changed path matches `include` and is not matched by `exclude`.
3. Run each selected check as one low-effort subagent. Give it the check file and the diff limited to the matching paths. Run them beside the blocker review, not as extra rounds.
4. Treat findings as input to the single blocker-fix pass. A check never blocks on style or asks for new tests, guards or edge cases beyond its own rule.
