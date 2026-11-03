---
name: test-signal
include:
  - "tests/**"
exclude:
  - "tests/fixtures/**"
---

Review only added or grown tests in the diff against the Testing rules in `AGENTS.md`. You may only ask for fewer or smaller tests. Never ask for new tests, new cases or more coverage.

Questions:

1. Does a test assert the same observable outcome that another test (new or existing) already proves? Name the duplicate and the one to delete.
2. Is a scenario split across tests that share one precondition and action (one scenario per assertion)? Name the tests to merge.
3. Does a test pin an implementation detail (private helper call, call order, internal shape) rather than the contract? Name what to delete or loosen.
4. Is a test tautological (asserts what the mock returns, or restates the code)?
5. Is a test at a higher layer than needed, such as Playwright (`tests/browser/`) covering a case a lower layer proves? Keep one or two tests per journey.
6. Are there `tests/renderer/` additions? AGENTS.md says no renderer tests until asked.
7. Is the combination matrix exhaustive where a contract-focused case would do?

Reply `All clear` if nothing applies. Otherwise one line per finding: `file:line — problem — minimal fix`, where the fix deletes, merges or shrinks.
