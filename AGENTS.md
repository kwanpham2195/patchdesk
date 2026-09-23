# Repository Guidelines

## Non-negotiables

Child briefs must include applicable rules below or readable absolute paths to them. Paste these five lines into every implementation brief.

- Commit each accepted slice with explicit paths, and end the report with the SHA.
- A renderer change is finished only after you looked at a screenshot of the affected screen over CDP.
- Run `pnpm check` before handoff.
- No compatibility shims or fallbacks unless asked for.
- Ask before removing code that looks intentional.

These commit and check gates apply to accepted authorized changes, including instruction edits. For read-only work or a blocked, partial, or checkpoint report, name dirty-file ownership, checks actually run, and pending gates instead of claiming completion.

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

For runtime work, make sure the dev log tails are live in herdr:

- Log tail tab: raw `patchdesk.jsonl` (tail of `~/.local/share/patchdesk/logs/patchdesk.jsonl`).
- Dev tab: the `pnpm dev` console (renderer/api log lines and HMR output).
- If either pane is gone or idle, restart it without asking: the maintainer has authorized restarting the dev app and log tail in their herdr panes (`wF:p3Q` for the app, run `REMOTE_DEBUGGING_PORT=9233 pnpm dev`; SIGINT the process group first if it is still running, since ctrl+c to the pane does not stop it). Say in the report that you restarted it. Never kill a process outside those panes.
- Main-process code changes (e.g. `src/main/`, `src/services/`, adapters) need a full dev-app restart: renderer hot-reloads but the main process keeps the old code.

- `CONTRIBUTING.md` and the package scripts define verification commands. `pnpm check` is the pre-handoff command for completed authorized implementation, including instruction edits.
- Run it as `pnpm check > /tmp/check.txt 2>&1; echo "EXIT=$?"` and read the
  file. Piping it into `tail`, `head`, or `grep` reports the pipeline's exit
  status rather than the command's, so a failing gate reads as a passing one.
- `pnpm check` ends in `lint:changed` against a base ref, which reads the git
  **index**, not the working tree (see `scripts/check-changed-source.mjs`).
  Stage or commit your paths first, or it reports violations you have already
  fixed on disk.
- `pnpm format` runs `oxfmt` repo-wide and reformats unrelated Markdown across
  `docs/`, `AGENTS.md`, and `README.md`. Format explicit paths with
  `npx oxfmt <paths>` instead.
- Drive the running app with `agent-browser` over CDP. Read-only by default; ask before any write. A renderer change is finished only when you have looked at a screenshot of the affected screen taken after the change loaded; an API response, a log line, or a passing test is not live verification, so say which you have.
- `location.reload()` is swallowed by this app: a `window` global survives the call. Reload with `agent-browser reload` (CDP `Page.reload`).
- After a change that adds or removes a Tailwind utility class, reload rather than waiting on HMR. Vite's regenerated CSS can fail to reach the running renderer, leaving the stale rule in `document.styleSheets` indefinitely.
- CDP: `pnpm dev` listens only with `REMOTE_DEBUGGING_PORT` set. Port 9233 is the maintainer's app; a session that needs its own takes `REMOTE_DEBUGGING_PORT=924N` and its own user-data dir, and never kills a process outside the dev panes. Restarting 9233 itself is pre-authorized; report it. `pnpm cdp:ready` checks the port: run it before claiming runtime evidence, reporting live verification, or delegating a live-verification slice.
- Package only when asked, when the change is packaging-specific, or when distribution proof is required. A packaged app is evidence only for the commit it was built from.
- Insight runs started for testing (Brief, Analysis, Walkthrough) spend the maintainer's provider account. Use a low-cost model such as `gpt-5.6-luna` on the Codex CLI account provider, not `gpt-5.6-sol`; pick it in the run dialog rather than changing the maintainer's stored preference.
- Before delegating or resuming a child, read `~/.agents/skills/delegated-execution/references/model-policy.md`. It owns role, model, effort, concurrency, and unavailable-model rules; the active harness owns launch and failure protocol.

- An audit or inventory ships with a disposition per finding: fix now, a named follow-up, or an evidence-backed rejection.
- A remediation program pins its metric to one exact command in its plan file; every progress report reruns it.

## Code and Testing Conventions

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Comments preserve non-obvious intent, invariants, trade-offs, or external constraints. Prefer one sentence explaining why; let code describe what and how. Use longer comments only when a complex invariant cannot be expressed clearly in code. The codebase still carries long comments from before this rule; they are not a pattern to copy. Follow this rule, not the neighbouring code.
- Documentation ownership: ADRs record durable decisions and consequences; code comments explain local constraints; commit messages record change history. Link to the owning source instead of repeating it.
- When a later ADR changes current guidance, add a supersession note to the earlier ADR. Keep its historical decision intact.
- Check node_modules for external API types; don't guess.

## Testing

Test at the lowest layer that can observe the behaviour.

- Domain and services: every behaviour has a test, written before the fix.
  A bug fix lands with the regression test that failed on `main`.
- Hooks: a hook that owns timing, generations, optimistic state, or a request
  payload gets a `renderHook` test with a fake bridge. Do not test hook logic
  by mounting the component that uses it.
- Components: one smoke test per screen (renders a fixture; primary actions
  call their props) plus keyboard and focus tests that need a DOM. No
  assertions on copy sentences, class names, badge tone, or element order. If
  a component computes something worth asserting, export the function and
  test the function.
- Query by role or label (`getByRole`, `getByLabelText`), never by class name
  or by a sentence of copy.
- Playwright (`tests/browser/`): end-to-end journeys and things only a real
  browser shows (Pierre CodeView scrolling, virtualisation, computed CSS,
  performance budget). Never a behaviour an RTL or hook test already proves.
- Test doubles: use the shared helpers (`tests/renderer/fake-desktop-response.ts`
  for `window.patchdesk`, `FakeGitHubAdapter` for the GitHub gateway). Do not
  hand-roll a new `Object.defineProperty(window, "patchdesk", ...)` or an
  inline gateway fake.
- Invariants that span flows (every GitHub write persists intent before the
  network call; every Review entry point takes the coordinator lock; every
  preparation step is recoverable after a crash) are table-driven tests over
  all flows, not one test per service.
- Every test must protect a distinct behavior, boundary, failure mode, or wiring contract. Do not add a test only because a new branch or function exists.
- Give each behavior one canonical test owner at the lowest observable layer. Higher-layer tests keep only wiring, browser-only behavior, keyboard, focus, or another contract the owner cannot observe.
- Before merging or deleting tests, name the retained test and compare preconditions, branches, assertions, and relevant success, error, retry, ordering, crash, and concurrency behavior. Shared line coverage is not equivalent coverage.
- Use tables and shared fixtures to remove repeated setup while preserving separate cases and useful failure names. Do not put independent scenarios in one test or loop to reduce the reported test count.
- A parser or schema happy-path test must assert meaningful validation or transformation. Do not echo ordinary valid input when boundary and negative cases already protect the contract.
- Recovery, concurrency, security, storage, protocol, and cross-flow invariant tests require fault evidence before non-obvious consolidation or deletion.
- No assistive-technology tests: no axe scans, no screen-reader narration
  checks, no forced-colors or reduced-motion checks (ADR 0034).
- Before adding a test, check whether one already asserts the behaviour at a
  lower layer or in another file. Duplicates are deleted, not kept "for
  safety".

## Implementation notes

Lessons from past sessions and commits that code cannot enforce. Each one cost a wasted pass at least once.

Dev app and live checks:

- A running Patchdesk holds `app.requestSingleInstanceLock()`; a second instance opens CDP and quits with no error. When 9233 "never comes up", look for the older process first.
- App data is `~/.local/share/patchdesk` for every instance; a separate `--user-data-dir` does not give a separate workspace or review store.
- After a renderer `.ts` -> `.tsx` rename, restart `pnpm dev`. Vite's transform cache keeps the old import path in every importer, the lazy route fails on MIME, and `agent-browser reload` does not clear it.
- `agent-browser` must use the default session: named sessions call `Target.createTarget`, which Electron's CDP does not implement. Base UI `Select` opens with focus then Enter, not a click. Fixture hashes route only on a full load, so `agent-browser reload` after changing the hash.
- Inline finding cards on the Diff tab are slotted into `<diffs-container>` only while their row is in the render window; scroll `.review-diff-viewport`, not the card.
- Behaviour that needs a second GitHub actor (someone else's last comment, a push while away) cannot be self-verified live. Say so and name the state a reviewer should check.

Main process and GitHub:

- Anything in the main process that reads `process.env` (PATH, provider keys) must await the login-shell import (ADR 0038); a default-parameter read of `process.env.PATH` raced ahead of it once already.
- IPC channel names live in one shared module both `preload.ts` and the main side import (`src/main/*-channel.ts`); main and preload are separate entry points, so a mismatched literal breaks the feature with every test green.
- `http.Server#close()` waits for keep-alive sockets forever; `local-api.ts` calls `closeAllConnections()`. A Playwright teardown that "times out at 30 s with no failing assertion" is this, not a slow test.
- GraphQL rate-limit exhaustion arrives as HTTP 200 with `errors[].type === "RATE_LIMITED"`; classify it there, not from the status code. Free-text GraphQL variables go as `kind: "string"`, or an all-digit search is sent as an Int.
- A write is `rejected` only on a refusal GitHub actually returned. Network errors, timeouts, 5xx, and unparseable success bodies are outcome-unknown: keep the operation locked for reconciliation (ADR 0035), and match recovery evidence by body and anchor, never "any comment created after".
- A confirmed write stays confirmed when a later bookkeeping step (journal append, cache write) fails; log and continue, never re-lock or re-offer it.
- Path containment uses `isPathContained` in `src/adapters/storage/path-containment.ts`, never `startsWith` on the string; five modules once each wrote their own and two disagreed on whether the root counts.

Tests and gates:

- No file may grow past 1,000 lines and no new file past 500 (`scripts/file-growth-lib.mjs`, pre-commit). Check the size before adding to a large file and split first; this blocked 17 sessions.
- Run one `pnpm check` at a time. Two at once reproduce the concurrent-load flakes (#108, #145). When a timing test fails and passes on retry, check `ps -Ao pid,pcpu,etime,comm | awk '$2>50'` for a hung `trash` before reading the test.
- Knip does not read CSS: a dependency it flags may be live via `styles.css`. Deleting the last consumer of an export fails `knip:ratchet` at 0, so delete the dead export in the same commit.
- `vi.spyOn` on a real module is banned (`tools/oxlint/patchdesk/no-method-spying`); record calls on the injected fake. Read `tools/oxlint/anti-slop/rules/` before naming a parameter type or writing a test double.
- Relative-time assertions against fixture timestamps drift with the calendar; pin the clock with `vi.setSystemTime`, never widen the regex.
- Global keydown handlers check the focused editable element and bail on a held modifier (B-08, B-23). A control disabled by a state rule renders the reason beside it (B-10, B-11, B-19).

Process:

- Static copy, alert, and message changes go straight to main. Behaviour changes get their own PR with before/after screenshots in the body (`before-and-after` skill). Prompt and schema changes are reviewed in chat first.
- Throwaway PRs are always fine for live checks, including writes. Real PRs still need a per-write ask.
- `Closes #n` auto-closes only the first number after it; repeat the keyword per issue, and close finished issues before starting the next.
- Once an action is approved, do not re-ask for its sub-steps. Ask again only for a new destructive or outward action.
- One review pass for blockers, then gate and land; list skipped nits in the recap. Report a test-count change against its baseline, not as a raw total.

## Git

Multiple AI sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- For accepted authorized changes, commit each phase or milestone after its verification gate and report the SHA. For read-only, blocked, partial, or checkpoint reports, state dirty-file ownership, checks actually run, and pending gates truthfully.
- Message format: informative and concise.

Stopping:

- Stop for a user-requested human review, an explicit pause, a decision the plan does not cover, a failed gate, or a GitHub write. Name the review, pause, decision, or blocker; "Continue with the next step?" is not a stop. The `delegated-execution` skill has the full rule.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Skills

Use the named skill when its trigger matches the task. Read the skill file before acting; it is the canonical workflow.

- `code-review`: before any handoff that changed `src/`. Run it yourself; do not wait to be asked.
- `delegated-execution`: substantial exploration, work that spans several files, or several subagents.
- `react-doctor`: finishing React work or checking React diagnostics before handoff.
- `diffs`: working with `@pierre/diffs`, code views, patches, or review surfaces.
- `trees`: working with `@pierre/trees` file trees.
- `shadcn`: adding, debugging, or composing shadcn/ui components.
- `agent-browser`: live browser or Electron verification over CDP.
- `herdr`: dev servers, log tails, watchers, and named panes.
- `issue`: every bug, request, decision, or idea worth tracking goes to GitHub Issues (the tracker for this repo) through issue intake and handoff. Use `~/.agents/skills/issue/SKILL.md`; its permission and destination rules decide whether anything is published.
- `pr`: pull request inspection, updates, CI, and landing. Use `~/.agents/skills/pr/SKILL.md`.
- `product-description`: a user-visible behaviour change updates its page under `docs/product-description/`; a new page, checklist, or triage entry follows the skill's "Resuming and extending an existing repo" steps. Read that folder's README.md and goal.md before writing.
- `librarian`: caching or consulting an upstream repository or dependency source.
- `update-changelog`: before editing a changelog.

## References

- Codex app-server protocol reference: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md> (cache it with `$librarian`).

## Memory

- Route new private work records with `~/.agents/skills/references/context-routing.md` to the registered workspace context. Do not create local repository folders for them.
