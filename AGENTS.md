# Repository Guidelines

## Non-negotiables

Child briefs must include applicable rules below or readable absolute paths to them. Paste these five lines into every implementation brief.

- Commit each accepted slice after final verification with explicit paths, and end the report with the SHA.
- A renderer change is finished only after you looked at a screenshot of the affected screen over CDP.
- Defer unit tests and test-running checks until final verification; then run affected-package checks. The commit hook runs changed-file checks; the full `pnpm check` runs once at landing, on the rebased head, before merge.
- No compatibility shims or fallbacks unless asked for.
- Ask before removing code that looks intentional.

These commit and check gates apply to accepted authorized changes, including instruction edits. For read-only work or a blocked, partial, or checkpoint report, name dirty-file ownership, checks actually run, and pending gates instead of claiming completion.

## Agent assignments

- Default future Patchdesk assignments to Claude Code. An explicit task harness choice wins. Follow the Claude Code role/model/effort conventions in `~/.agents/skills/delegated-execution/references/model-policy.md`. Verify model and effort availability at dispatch and ask Matthew if unavailable, without substituting. This default grants no launch authority and does not migrate or reconfigure existing threads, schedules, app/runtime settings, accounts, providers or secrets.

## Project Structure

See `CONTRIBUTING.md` (codebase map) and `docs/architecture.md` (layers) for the full picture.

## Conversational Style

- Remove all mannered prose.
- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Development and Verification

- Define each substantial slice by an observable user outcome and its verification. Include the producer and its real consumer where practical. Label infrastructure prerequisites explicitly; passing their checks does not complete the product milestone.
- Once a minimal runtime path works, verify it in the actual app and provider before expanding abstractions or coverage. Obtain required paid-run approval before reaching that gate.
- After a live failure, investigate and repair the failing stage before expanding tests, refactoring unrelated code or adding infrastructure. If attribution is missing, add the smallest approved diagnostic that distinguishes the possible causes.
- Progress reports state what newly works, the remaining blocker and the next observation needed. Passing tests, completed helpers and launch counts do not establish product completion.

Verification order for agents:

- Implement first, reproduce the requested behavior live, and fix defects in the approved flow before final verification. During implementation and live debugging, do not add, expand, repair, or run unit tests unless Matthew explicitly requests an exception. A general approval to continue is not test authorization.
- Use source inspection, diagnostic logs, live checks, formatting, lint and typechecking during implementation. Defer test-running package checks and commit hooks until final verification; defer commits rather than bypassing hooks. This timing governs the test commands listed in `CONTRIBUTING.md`.
- At final verification, run the required checks. New test scenarios still require separate approval, and approved coverage must be minimal and contract-focused rather than exhaustive combinations.
- No interim formal code-review rounds or review subagents unless Matthew explicitly asks. Inspect source and diffs as needed to debug. Perform the final review only after live verification passes; apply required blocker fixes and rerun affected verification before handoff or landing.

For runtime work, keep the dev console and raw log tail live in this workspace's tmux session:

- `logs` pane: raw `patchdesk.jsonl` (tail of `~/.local/share/patchdesk-dev/logs/patchdesk.jsonl` for `pnpm dev`).
- `devapp` pane: the `pnpm dev` console (renderer/api log lines and HMR output).
- The maintainer authorizes restarting the dev app and log tail in this workspace's existing `devapp` and `logs` tmux panes. Resolve their current IDs with `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index} #{pane_id} #{pane_title} #{pane_current_path} #{pane_pid}'`. Verify the session and pane title, inspect the process cwd and process tree rooted at the pane PID, and read recent output with `tmux capture-pane -p -t '<pane-id>' -S -120` before control. Send SIGINT only to the verified dev or log foreground process group before restarting. Never kill a process outside those panes. The maintainer also authorizes managing the `patchdesk` tmux session in any session: create it, or its `devapp` and `logs` panes, when missing. Ask only when a pane's ownership is unclear.
- Run `REMOTE_DEBUGGING_PORT=9233 pnpm dev` in the verified dev pane. After restarting, wait for `pnpm cdp:ready`; old tmux scrollback is not readiness evidence. Report restarts.
- Main-process code changes (e.g. `src/main/`, `src/services/`, adapters) need a full dev-app restart: renderer hot-reloads but the main process keeps the old code.

- At final verification, use `pnpm check:package root`, `pnpm check:package insight`, or both for affected packages. `CONTRIBUTING.md` and package scripts define the commands; shared configuration requires every affected package. Every commit runs only the checks its staged paths need (CONTRIBUTING.md, The commit gate); a Markdown-only commit takes seconds. The full `pnpm check` is the landing gate: run it on the rebased head before `gh pr merge`. The `Pull request gates` workflow is paused, so no GitHub status checks run on pull requests; the `CI` workflow runs on pushes to `main` only, as a backstop. The `Release` workflow runs again since 2026-09-30: a pushed `v*` tag drafts the release (CONTRIBUTING.md, Release).
- Run it as `pnpm check > /tmp/check.txt 2>&1; echo "EXIT=$?"` and read the
  file. Piping it into `tail`, `head`, or `grep` reports the pipeline's exit
  status rather than the command's, so a failing gate reads as a passing one.
- `pnpm check` includes `lint:changed` against a base ref, which reads the git
  **index**, not the working tree (see `scripts/check-changed-source.mjs`).
  Stage or commit your paths first, or it reports violations you have already
  fixed on disk.
- `pnpm format` runs `oxfmt` repo-wide and reformats unrelated Markdown across
  `docs/`, `AGENTS.md`, and `README.md`. Format explicit paths with
  `npx oxfmt <paths>` instead.
- Use `/Users/kwanpham/.local/share/mise/installs/npm-agent-browser/0.37.0/bin/agent-browser` for every browser command below; the default PATH copy lacks `--namespace`. No install or PATH change is needed. Drive the running app with that executable over CDP. Read-only by default; ask before any write. A renderer change is finished only when you have looked at a screenshot of the affected screen taken after the change loaded; an API response, a log line, or a passing test is not live verification, so say which you have.
- If a live check finds a reproducible UI or UX defect in the approved flow, fix it before handoff, then rerun that flow and inspect a new CDP screenshot. If the fix changes scope or needs a product decision, record the defect and get approval; leave the live check pending until resolved.
- `location.reload()` is swallowed by this app: a `window` global survives the call. Reload with `agent-browser reload` (CDP `Page.reload`).
- After a change that adds or removes a Tailwind utility class, reload rather than waiting on HMR. Vite's regenerated CSS can fail to reach the running renderer, leaving the stale rule in `document.styleSheets` indefinitely.
- CDP: `pnpm dev` listens only with `REMOTE_DEBUGGING_PORT` set. Port 9233 is the maintainer's app; a session that needs its own takes `REMOTE_DEBUGGING_PORT=924N` and its own user-data dir, and never kills a process outside the dev panes. Restarting 9233 itself is pre-authorized; report it. `pnpm cdp:ready` checks the port: run it before claiming runtime evidence, reporting live verification, or delegating a live-verification slice.
- Package only when asked, when the change is packaging-specific, or when distribution proof is required. A packaged app is evidence only for the commit it was built from.
- Insight runs started for testing (Brief, Analysis, Walkthrough, Guide) spend the maintainer's provider account. Use `gpt-6-luna` on the Codex CLI account provider for smoke runs, not a Sol model. Judge Analysis quality with GPT-6.1 Terra at high reasoning: on a 516-file PR, Luna approved after reading 15 diffs while Terra found a P1 (2026-10-27). Pick the model in the run dialog rather than changing the maintainer's stored preference, and check the provider before Start, because selecting an Insight loads its saved provider. If a model is missing from the list, press Refresh models.
- Before delegating or resuming a child, read `~/.agents/skills/delegated-execution/references/model-policy.md`. It owns role, model, effort, concurrency, and unavailable-model rules; the active harness owns launch and failure protocol. For multi-slice implementation plans, use one worker per slice, sequentially, and pass the previous report forward instead of its full history.

- An audit or inventory ships with a disposition per finding: fix now, a named follow-up, or an evidence-backed rejection.
- A remediation program pins its metric to one exact command in its plan file; every progress report reruns it.

## Code and Testing Conventions

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Comments preserve non-obvious intent, invariants, trade-offs, or external constraints. Prefer one sentence explaining why; let code describe what and how. Use longer comments only when a complex invariant cannot be expressed clearly in code. The codebase still carries long comments from before this rule; they are not a pattern to copy. Follow this rule, not the neighbouring code.
- Documentation ownership: ADRs record durable decisions and consequences; code comments explain local constraints; commit messages record change history. Link to the owning source instead of repeating it.
- Keep UI and MCP as thin adapters over the same service. Put shared decisions, validation, and result shaping in domain or service code; see `docs/architecture.md`.
- When a later ADR changes current guidance, add a supersession note to the earlier ADR. Keep its historical decision intact.
- Check node_modules for external API types; don't guess.
- Add bounded, privacy-safe diagnostic logs at important transitions and failure boundaries so later debugging can identify the failing stage without reconstructing the incident. Use fixed reason codes and existing correlation. Preserve the first observed failure before cleanup, distinguish failures at separately awaited cleanup stages, and keep cleanup errors from replacing the original failure. Distinguish observation from root cause. Never log credentials, prompts, source bodies, raw tool arguments or provider prose; logging failures must not change business outcomes. Use existing log owners and retention rather than inventing another telemetry system.

## Testing

- Test observable behaviour at the lowest layer that can prove the contract.
- Follow the verification order above: no unit-test work before final verification without an explicit exception. Necessary repairs to existing tests belong in final verification. New scenarios or expanded coverage require separate user approval even then. This policy applies only to Patchdesk.
- No `renderer` tests until asked.

- Write one scenario per test, with as many assertions as needed to prove its relevant outcomes.
- Separate scenarios with different preconditions or actions; do not split one scenario per assertion.
- No tautological tests.
- Tests must survive internal refactoring that preserves the contract.
- Control nondeterminism with fixed clocks, seeded data, and controllable promises where needed.
- Playwright (`tests/browser/`): end-to-end journeys and things only a real browser shows. Keep one or two tests per journey; do not cover every scenario.
- Before adding a test, find the existing owner of the behaviour and extend it where appropriate.

## Implementation notes

Lessons from past sessions and commits that code cannot enforce. Each one cost a wasted pass at least once.

Dev app and live checks:

- If `pnpm dev` dies with "The requested module 'electron' does not provide an export named 'BrowserWindow'", Electron is running as plain Node because `ELECTRON_RUN_AS_NODE=1` leaked from an agent harness into the shell or tmux server. Run `tmux set-environment -g -u ELECTRON_RUN_AS_NODE` and `unset ELECTRON_RUN_AS_NODE` in the pane before restarting (2026-10-22).
- A running Patchdesk holds `app.requestSingleInstanceLock()`; a second instance opens CDP and quits with no error. When 9233 "never comes up", look for the older process first. `pnpm dev` uses its own Electron profile (`~/Library/Application Support/Patchdesk Dev`), so an installed Patchdesk does not hold its lock.
- An unpackaged `pnpm dev` keeps its own config, data and cache in `~/.config/patchdesk-dev`, `~/.local/share/patchdesk-dev` and `~/.cache/patchdesk-dev`; the installed app keeps `~/.config/patchdesk` and the like. A fresh dev profile is empty: run `pnpm dev:copy-profile` to copy the installed `config.json` and profiles (it refuses over an existing dev config without `--force`). `PATCHDESK_DEV_SHARED=1 pnpm dev` runs against the installed roots, for a check that needs the real store; it uses `patchdesk-dev.sock` so both apps can listen. A separate `--user-data-dir` does not change these roots.
- After a renderer `.ts` -> `.tsx` rename, restart `pnpm dev`. Vite's transform cache keeps the old import path in every importer, the lazy route fails on MIME, and `agent-browser reload` does not clear it.
- When several sessions drive CDP 9233 at once, each passes its own `agent-browser --namespace <name> --cdp 9233`; without it they rebind the shared daemon and clicks land on another session's target (2026-09-27). A namespace is not a named session.
- `agent-browser` must use the default session: named sessions call `Target.createTarget`, which Electron's CDP does not implement. After `tab_gone`, run `agent-browser --namespace <name> --cdp 9233 tab list --json`, find the `http://localhost:5173/` target's `targetId`, then run `agent-browser --namespace <name> --cdp 9233 tab <targetId>` to rebind. Do not use `tab new` on Electron. Base UI `Select` opens with focus then Enter, not a click. Fixture hashes route only on a full load, so `agent-browser reload` after changing the hash. If a pointer-level browser command stalls, use `eval` to scroll the relevant element.
- Before a live check, `agent-browser eval 'document.visibilityState'` must say `visible`. A covered or off-screen window drops CDP input while `agent-browser click` still prints Done, and Base UI dialogs never finish closing; bring it forward with `aerospace focus --window-id <id>` (`aerospace list-windows --all | grep Patchdesk`).
- Inline finding cards on the Diff tab are slotted into `<diffs-container>` only while their row is in the render window; scroll `.review-diff-viewport`, not the card.
- Behaviour that needs a second GitHub actor (someone else's last comment, a push while away) cannot be self-verified live. Say so and name the state a reviewer should check. CDP 9233 serves the main checkout, so a worker in a worktree cannot verify that worktree's renderer change there; name the screen and state for a reviewer to verify instead.
- In the dev app, macOS may list desktop notifications under Electron. Check the dev log (`~/.local/share/patchdesk-dev/logs/patchdesk.jsonl`) for a `shown` event before diagnosing a missing banner as an app defect.
- In agent shells, `cp` may be interactive. Use `command cp -f` when restoring over an existing file, then verify the diff.

Main process and GitHub:

- Insight evidence validity comes from the host-held recursive tree index; concatenating `diff/` files in `files.json` order must reproduce the captured patch hash.

- `patchdesk/no-unowned-process-env`: `process.env` is read only in the owner modules listed in `.oxlintrc.json`. Main-process owners await the login-shell import first (ADR 0038); executable discovery reads PATH through `importedProcessPath`.
- `patchdesk/no-ipc-channel-literal`: IPC channel names are imported from the shared `src/main/*-channel.ts` module, never written as literals; main and preload are separate entry points, so a mismatched literal breaks the feature with every test green.
- `http.Server#close()` waits for keep-alive sockets forever; `local-api.ts` calls `closeAllConnections()`. A Playwright teardown that "times out at 30 s with no failing assertion" is this, not a slow test.
- GraphQL rate-limit exhaustion arrives as HTTP 200 with `errors[].type === "RATE_LIMITED"`; classify it there, not from the status code. Free-text GraphQL variables go as `kind: "string"`, or an all-digit search is sent as an Int.
- A write is `rejected` only on a refusal GitHub actually returned. Network errors, timeouts, 5xx, and unparseable success bodies are outcome-unknown: keep the operation locked for reconciliation (ADR 0035), and match recovery evidence by body and anchor, never "any comment created after".
- A confirmed write stays confirmed when a later bookkeeping step (journal append, cache write) fails; log and continue, never re-lock or re-offer it.
- `patchdesk/no-string-path-containment`: path containment uses `isPathContained` in `src/adapters/storage/path-containment.ts`, never `startsWith` on a path string; five modules once each wrote their own and two disagreed on whether the root counts.

Process:

- Every change goes through a PR, including static copy, alerts, messages, and instructions. Behaviour changes include before/after screenshots in the body (`before-and-after` skill). Prompt and schema changes are reviewed in chat first.
- Throwaway PRs are always fine for live checks, including writes. For real PRs, follow the scoped write approval under Standing authorization.
- `Closes #n` auto-closes only the first number after it; repeat the keyword per issue, and close finished issues before starting the next.
- A PR that fixes an issue says `Closes #n` in its body, and after it lands `gh issue view <n> --json state` must read `CLOSED`. A CHANGELOG citation alone closes nothing: nine fixed bugs stayed open for weeks that way (closed 2026-09-26). Before fixing an old issue, check CHANGELOG and `git log` for its number.
- Once an action is approved, do not re-ask for its sub-steps. Follow Standing authorization for approved programs and new actions.
- After live verification passes and before merging, get one final independent blocker-focused review for changes to storage, GitHub writes, locking, or the main process, and for PRs over 300 changed lines. Smaller renderer or copy PRs need a final self-review. Do not insert interim review rounds. Make one fix pass for blockers, then gate and land; list skipped nits in the recap. Report a test-count change against its baseline, not as a raw total.

## Standing authorization

- When the maintainer approves execution of a plan or multi-issue program, record its scope, authorized actions, delegation budget, and completion condition in the owning plan. Continue approved slices without asking to proceed. Use the approved budget without repeated requests; do not exceed the plan or harness limit without approval.
- Read-only screenshots and the dev-pane restarts authorized above need no additional approval. An approval to draft or review a plan does not authorize its execution.
- Pushes, real-PR creation and updates, and merges are authorized across slices only when the approved execution plan explicitly names those actions and the slices they cover. The parent performs those writes after required gates and reviews. Otherwise ask before each outward write. Ask before removing code that looks intentional, changing scope, or taking a new destructive action; repair failures caused by approved work and rerun without another pause. Stop for unrelated failures, repairs outside scope, or required human review.

## Git

Multiple AI sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- For accepted authorized changes, commit each phase or milestone after final verification and report the SHA. Before that point, preserve scoped work and report checkpoints without running test-bearing hooks early. For read-only, blocked, partial, or checkpoint reports, state dirty-file ownership, checks actually run, and pending gates truthfully.
- Message format: informative and concise.

Stopping:

- Stop for a user-requested human review, an explicit pause, a decision the plan does not cover, an unrelated or out-of-scope gate failure, or a GitHub write that lacks scoped approval. Name the review, pause, decision, or blocker; "Continue with the next step?" is not a stop. The `delegated-execution` skill has the full rule.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Skills

Use the named skill when its trigger matches the task. Read the skill file before acting; it is the canonical workflow.

- `code-review`: at final verification after live checks pass, before handoff or landing of changes to `src/`. Do not run interim formal reviews or launch interim review subagents.
- `delegated-execution`: substantial exploration, work that spans several files, or several subagents.
- `react-doctor`: finishing React work or checking React diagnostics before handoff.
- `diffs`: working with `@pierre/diffs`, code views, patches, or review surfaces.
- `trees`: working with `@pierre/trees` file trees.
- `shadcn`: adding, debugging, or composing shadcn/ui components.
- `agent-browser`: live browser or Electron verification over CDP.
- `tmux`: dev servers, log tails, watchers, and named panes.
- `issue`: every bug, request, decision, or idea worth tracking goes to GitHub Issues (the tracker for this repo) through issue intake and handoff. Use `~/.agents/skills/issue/SKILL.md`; its permission and destination rules decide whether anything is published.
- `pr`: pull request inspection, updates, CI, and landing. Use `~/.agents/skills/pr/SKILL.md`.
- `product-description`: a user-visible behaviour change updates its page under `docs/product-description/`; a new page, checklist, or triage entry follows the skill's "Resuming and extending an existing repo" steps. Read that folder's README.md and goal.md before writing.
- `librarian`: caching or consulting an upstream repository or dependency source.
- `update-changelog`: before editing a changelog.
- `release`: cutting or publishing a release, bumping the Homebrew cask, or installing the latest version. Repo skill in `.agents/skills/release/`.
- `run-program`: batching issues into a tracking issue, or running or resuming one. Repo skill in `.agents/skills/run-program/`.

## References

- Codex app-server protocol reference: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md> (cache it with `$librarian`).

## Memory

- `docs/product-description/glossary.md` owns Patchdesk vocabulary and words to avoid. Read and update it instead of creating a root `CONTEXT.md`.
- Put durable project rules and preferences here so every agent harness can use them. Other harnesses do not load Claude Code project memory. Keep dated project status and scoped authorizations in the workspace context or tracker; check current state before relying on historical permissions.
- The issue tracker is GitHub Issues on this repository. Use the `issue` skill. For repository-authored specs, state the problem, then use `Why it matters`, `Scope`, and `Verification`; add `Open questions` and `Confidence` only when a real decision is pending.
- Read the summaries in `docs/product-description/` and `docs/product-description/bug-triage.md` before feature inventory or roadmap work. They describe shipped behavior and known gaps. `ROADMAP.md` records direction and order; check its Not planned section before proposing features, and update it when an issue moves between sections or a direction decision changes. Local Review is for reviewing agent changes, not for committing, pushing, or opening pull requests; read ADR 0051 before proposing changes to that workflow.
- Ask before removing or replacing README screenshots, adding light-theme variants, or starting another screenshot capture round; the existing dark-theme tour was deliberate.
