---
name: patchdesk-review-cache-recovery
description: "Recover a Patchdesk review that cannot open or prepare because of stale local cache."
---

# Patchdesk review cache recovery

Use this skill when Patchdesk reports that a pull request cannot open or prepare, or when the user asks to reset one review's local data.

## Safety boundary

- Recover one named PR only. Never clear a profile, all reviews, or shared config.
- GitHub reads are allowed; do not publish, merge, dismiss feedback, or make any other GitHub write.
- Do not remove anything until the user explicitly approves the exact local artifact.
- Cleanup applies only to a non-running session. Stop if the session state is `Running` or its activity is uncertain.
- Use `trash`, never `rm`, and do not manually remove worktrees, profile files, drafts, or publication receipts.

## Diagnose first

1. Use this repository's `agent-browser.json` to call `POST /v1/reviews/open` for the named `{ profileId, host, owner, repo, number }`.
2. Record its HTTP status and returned error. The renderer may reduce the cause to a generic alert, and the inbox's `openError` alert may not be visible when the details panel hides a stale row. A 200 response does not prove the workbench will open: the renderer re-validates the projection with `parseWorkbenchResponse` (`src/renderer/src/renderer-contracts.ts`). If the UI stays on the inbox with no alert, check the renderer console for a `parseWorkbenchResponse FAILED` log and read `brain/codebase/renderer-contract-boundary.md` before touching cache files.
3. Confirm the PR still exists with a read-only `gh pr view <number> --repo <owner>/<repo>`.
4. Inspect only the matching local artifacts:
   - Session: `~/.local/share/patchdesk/profiles/<profileId>/reviews/<sessionId>/`
   - Durable Review: `~/.local/share/patchdesk/profiles/<profileId>/workbenches/<reviewId>/review.json`
   - Generated Insights: `.../workbenches/<reviewId>/insights/`
5. Read `session.json` when it exists. A `Running` state blocks cleanup.

## Choose the smallest repair

- **Incompatible generated Insight:** If opening returns `storage` and one generated Insight is invalid for the current schema, preserve the session and remote snapshot. Ask to trash only that Insight file, such as `insights/analysis.json`.
- **Orphaned durable Review:** If opening returns `not_found`, GitHub confirms the PR exists, and `review.json` points to a missing session with no `representedRemote` snapshot, ask to trash only that PR's workbench directory. Patchdesk will prepare it again.
- **Snapshot hash mismatch:** If the workbench's `review.json` has `representedRemote.snapshotHash` that names no file in the `remote/` directory, the Review cannot project a represented snapshot. Ask to trash only that PR's workbench directory. Patchdesk will open a fresh session.
- **Missing disposable session:** If a durable Review has a valid represented snapshot but its non-running session artifacts are missing or corrupt, ask to trash only the matching session directory. Reopen to let Patchdesk rebuild it.
- **Any other state:** Do not guess. Report the evidence and stop for a code fix or user direction.

## Repair and prove it

1. State the exact path, why it is disposable, and what data remains before asking for approval.
2. After approval, run `trash <exact-path>` and verify the path no longer exists.
3. Call `POST /v1/reviews/open` again. Success is HTTP 200 with a `review` and `session` projection.
4. Optionally verify the live workbench directly with agent-browser. Do not require a tester subagent.
5. Report the original failure, removed local artifact, reopen result, and any retained Analysis, Walkthrough, draft, or snapshot data.
