# Commit Convention

The primary agent commits after significant, verified changes without waiting for an explicit prompt. "Significant" means a logical unit of work is complete and verified (typecheck, lint, tests pass). Small fixes during a conversation can accumulate into one commit; large features or refactors get their own commit with a descriptive message.

The user should not have to say "commit" after every completed piece of work. The agent uses its judgment.
