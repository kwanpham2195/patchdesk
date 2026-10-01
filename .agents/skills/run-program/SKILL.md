---
name: run-program
description: Plan and run a multi-issue Patchdesk program from a GitHub tracking issue, from collecting and ordering the work through landing each sub-issue. Use when the maintainer asks to batch issues into a tracker, fix a list of issues in order, or resume a tracker.
---

# Run a program from a tracking issue

A program is a set of GitHub issues landed one pull request at a time, in an order the maintainer approved. The tracking issue (the tracker) owns the order, the rules, the authorization, and the progress. Agent memory and chat do not hold program state: a new session resumes by reading the tracker body and its unchecked children.

Owning rules this skill does not repeat: `AGENTS.md` sections Standing authorization, Process, and Git (Stopping); the issue body style under Memory in `AGENTS.md`; `~/.agents/skills/delegated-execution/references/model-policy.md` for worker models; `~/.agents/skills/pr/SKILL.md` for PR mechanics.

Example tracker: #741.

## Phase 1: plan the tracker

1. Collect. List the candidate issues (`gh issue list --state open --label <label> --json number,title,labels`) plus whatever the maintainer named. Check each against `main`: search `CHANGELOG.md` and `git log` for its number, and confirm the line references still match. Mark already-fixed issues as stale for the review instead of closing them now.

2. Fill gaps. Create a sub-issue for any work that has none, in the repo body style: a plain problem statement, then `## Why it matters`, `## Scope`, `## Verification`. The Verification section holds the acceptance criteria. Add `## Open questions` and a `Confidence:` line only when a decision is pending. First line of the body: `Part of #<tracker>.` Labels carry the type (`bug`, `enhancement`, `documentation`) plus `ready-for-agent` when complete or `ready-for-human` when a maintainer decision is needed.

3. Order. Smallest change with the highest gain first. Give each item a size (S: small change, M: a few files with tests and docs, L: new subsystem) and its dependencies (`After #n`). Put items that touch the same files next to each other, or mark them to land together.

4. Write the tracker body:

   ```markdown
   <one paragraph: what the batch covers and why now>

   ## Why it matters

   ## Order

   - [ ] #n (S) Short title. After #m.

   ## Decisions

   ## Rules

   ## Authorization

   Pending the maintainer's approval.
   ```

   Rules: one PR per item unless grouped, `Closes #n` in each, the gate command from `AGENTS.md`, the live check each item needs, the review rule, and the merge method (`--rebase --match-head-commit`).

5. Review before showing. Spawn one read-only Opus reviewer agent (model `opus`; do not use Fable). Give it the tracker and every child body, tell it to read the cited code on `main`, and ask for blockers in order, stale scope, wrong line references, missing acceptance criteria, and the undecided questions it can settle. Apply one fix pass. Record each accepted decision in the child's `## Decisions` and summarize them in the tracker.

6. Show the maintainer the tracker link, the item count, the order, and any stale issues to close. Ask once for approval of the tracker, then end the turn.

## Phase 2: record the approval

Approval of the tracker covers, for every sub-issue in it: pushing branches, opening and updating PRs, merging them, and closing the issues, plus closing the tracker when done. Write that into `## Authorization` before the first slice: the date, the maintainer's words quoted, the covered actions, the delegation budget (one implementation worker at a time, plus review agents), the completion condition (every box ticked, every child closed), and the exclusions. Prompt and schema changes stay excluded and go to chat first unless the approval says otherwise. Close the stale issues it approved.

Edit tracker bodies through REST: `gh api repos/kwanpham2195/patchdesk/issues/<n> | jq -r '.body // ""' > /tmp/tracker.md`, edit the file, check it does not start with `"` or contain a literal `\n`, then `gh issue edit <n> --body-file /tmp/tracker.md`.

## Phase 3: land each slice

Repeat until the order list is done:

1. Pick the first unticked item whose dependencies are ticked. `git fetch origin`; branch from `origin/main`.
2. Delegate one implementation worker, in its own worktree, sequentially. The brief holds: the child issue number and body, the five `AGENTS.md` non-negotiables, the branch name (`fix/<n>-<slug>` or `feat/<n>-<slug>`), the gate command, the live check, and the previous slice's report. The worker commits locally and reports the SHA, the gate EXIT, and its live evidence; it does not push. A renderer live check runs on the worker's own port and user-data dir (`AGENTS.md`, Development and Verification).
3. Check the report: gate `EXIT=0`, the regression test for a bug fix, the CDP screenshot for a renderer change, or the named state a reviewer must check when it cannot be verified live.
4. Review per `AGENTS.md` Process: an independent blocker-focused Opus review for storage, GitHub writes, locking, the main process, or more than 300 changed lines; a self-review otherwise. One fix pass for blockers only; list the skipped nits.
5. Land: push, open the PR with `Closes #n` for each issue and before/after screenshots for behavior changes, then `gh pr merge <pr> --rebase --match-head-commit <sha>`.
6. Verify `gh issue view <n> --json state` reads `CLOSED`. If not, close it with a comment naming the PR.
7. Tick the box with the PR number (`- [x] #n (S) (#pr) Short title.`). Update the child when scope changed. File issues found during the work and list them under the tracker as opened during the work; add them to the order only when the authorization covers them.
8. Post a status update to the maintainer and continue with the next item without asking.

Status update shape, done and left counts first, every issue as `#n` with a short title:

```
Done 6/18, left 12.
Landed: #617 composer hint names its action (#<pr>).
Next: #615 return to Pull requests when a Visited row fails.
```

## Decisions and stops

- An undecided design question goes to a read-only Opus reviewer agent, not to the maintainer. Brief it with the options, the files to read in full, and "the maintainer delegated this call to you; do not defer it back". Record the answer in the child's `## Decisions`, then act on it.
- Stop only for the conditions in `AGENTS.md` Git > Stopping: a user-requested review, an explicit pause, a decision the tracker does not cover, a gate that stays red after the worker's fix pass, or an outward write the authorization does not cover. A prompt or schema change is such a write: bring the wording to chat.
- Name the stop reason and what waits on it. Never end a turn with "continue?".

## Completion

When every box is ticked and every child is `CLOSED`, close the tracker with a comment listing the landed PRs and follow-up issues. Final recap: 2 to 5 sentences on what landed, the test count change against the baseline at the program's start, skipped nits, and follow-ups.
