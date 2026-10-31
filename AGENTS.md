# Repository Guidelines

This file routes you to the document that owns each fact, then lists the rules that apply to every change. Each fact has one owner; other files link to it.

## Where to read

- `CONTRIBUTING.md`: Setup, codebase map, scripts, the commit gate, verification, release, PR and issue labels. Read it when: you build, test, commit, release or open a PR.
- `docs/architecture.md`: Process boundaries, layers, write rules, invariants. Read it when: you change code across layers, a write path or storage.
- `docs/adr/`: Durable decisions and their consequences. Read it when: you touch an area an ADR governs; a proposal that conflicts with one needs a new ADR.
- `docs/ui-guide.md`: Shared renderer primitives, surfaces, tokens. Read it when: you build or change a screen.
- `docs/mcp.md`: The MCP server contract: tools, instructions, errors. Read it when: you change an MCP tool or what a coding agent sees.
- `docs/product-description/`: Shipped user-visible behavior per feature; `glossary.md` owns vocabulary and words to avoid; `bug-triage.md` owns known gaps. Read it when: you name a concept, change behavior, or plan features.
- `ROADMAP.md`: Direction, order and Not planned. Read it when: you propose or reorder work.
- `README.md`: What Patchdesk is and how to install it. Read it when: you describe the product to outsiders.
- `docs/user-guide.md`: How a user runs the app. Read it when: a user-facing flow, setting or file location changes.
- `docs/upgrading-pi.md`: Native Pi CLI support and model refresh. Read it when: you touch Pi provider support.
- `CHANGELOG.md`: User-visible change history. Read it when: you ship a user-visible change (use the `update-changelog` skill).
- `.github/triage/PLAYBOOK.md`: How an agent diagnoses a user's problem with `patchdesk triage`. Read it when: you diagnose a user-reported problem.
- `.agents/skills/`: Repo workflows: `release`, `run-program`, UI and library skills. Read it when: the task matches a skill trigger below.
- `.agents/review-checks/`: Narrow final-verification checks selected by changed paths; nothing runs them for you. Read it at final verification (see Skills, `code-review`).

Lint rules explain themselves in their error messages; read the message instead of looking for the rule here.

## Non-negotiables

Child briefs must include the applicable rules below. Paste these five lines into every implementation brief.

- Commit each accepted slice after final verification with explicit paths, and end the report with the SHA.
- A renderer change is finished only after you looked at a screenshot of the affected screen over CDP.
- Defer unit tests and test-running checks until final verification; then run affected-package checks. The commit hook runs changed-file checks; the full `pnpm check` runs once at landing, on the rebased head, before merge.
- No compatibility shims or fallbacks unless asked for.
- Ask before removing code that looks intentional.

These commit and check gates apply to accepted authorized changes, including instruction edits. For read-only work or a blocked, partial, or checkpoint report, name dirty-file ownership, checks actually run, and pending gates instead of claiming completion.

## Conversational Style

- Remove all mannered prose. Technical prose only, direct, short.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler (for example "Thanks @user", not "Thanks so much @user!").
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, say whether you agree or disagree before saying what you changed.

## Hit every surface

A fix that works on the tested path and is missing elsewhere is a common defect. Before you call a change done, check each of these and say which you changed or ruled out:

- The renderer and the MCP tool for the same service action. Both stay thin adapters over one service.
- The local API.
- Local Review and pull request Review.
- The Codex and Pi providers.
- Reverse states: undo, retract, close, reopen, disconnect, reconnect.
- GitHub writes with an unknown outcome (ADR 0035): keep the operation locked for reconciliation.
- The matching page under `docs/product-description/`, and the glossary if a term changed.

## Development and Verification

- Define each substantial slice by an observable user outcome and its verification. Include the producer and its real consumer where practical. Label infrastructure prerequisites explicitly; passing their checks does not complete the product milestone.
- Once a minimal runtime path works, verify it in the actual app and provider before expanding abstractions or coverage. Obtain required paid-run approval before reaching that gate.
- After a live failure, investigate and repair the failing stage before expanding tests, refactoring unrelated code or adding infrastructure. If attribution is missing, add the smallest approved diagnostic that distinguishes the possible causes.
- Progress reports state what newly works, the remaining blocker and the next observation needed. Passing tests, completed helpers and launch counts do not establish product completion.

Verification order:

- Implement first, reproduce the requested behavior live, and fix defects in the approved flow before final verification. During implementation and live debugging, do not add, expand, repair, or run unit tests unless the maintainer explicitly requests an exception. A general approval to continue is not test authorization.
- Use source inspection, diagnostic logs, live checks, formatting, lint and typechecking during implementation. Defer test-running package checks and commit hooks until final verification; defer commits rather than bypassing hooks.
- At final verification, run `pnpm check:package root`, `pnpm check:package insight`, or both for affected packages; shared configuration requires every affected package. New test scenarios still require separate approval, and approved coverage must be minimal and contract-focused.
- No interim formal code-review rounds or review subagents unless the maintainer explicitly asks. Perform the final review only after live verification passes; apply required blocker fixes and rerun affected verification before handoff or landing.
- `CONTRIBUTING.md` owns the commit gate, the landing gate and the `context-increase:` message line for `context-budget.json`, which also pins the size of this file.

Gate traps:

- Run the full gate as `pnpm check > /tmp/check.txt 2>&1; echo "EXIT=$?"` and read the file. Piping it into `tail`, `head`, or `grep` reports the pipeline's exit status, so a failing gate reads as a passing one.
- `pnpm check` includes `lint:changed`, which reads the git **index**, not the working tree. Stage or commit your paths first, or it reports violations you already fixed on disk.
- `pnpm format` reformats unrelated Markdown repo-wide. Format explicit paths with `npx oxfmt <paths>`.
- An audit or inventory ships with a disposition per finding: fix now, a named follow-up, or an evidence-backed rejection.
- A remediation program pins its metric to one exact command in its plan file; every progress report reruns it.

Live checks (CONTRIBUTING.md has the dev app commands):

- Drive the running app with `agent-browser` over CDP. Read-only by default; ask before any write. An API response, a log line, or a passing test is not live verification; say which evidence you have.
- Read the CDP port from the `dev:` startup line. In a git worktree `pnpm dev` runs its own app with its own ports and profile; in the main checkout it listens only when `REMOTE_DEBUGGING_PORT` is set. Run `pnpm cdp:ready` before claiming runtime evidence or delegating a live-verification slice.
- If a live check finds a reproducible UI or UX defect in the approved flow, fix it before handoff, then rerun that flow and inspect a new CDP screenshot. If the fix changes scope or needs a product decision, record the defect and get approval; leave the live check pending until resolved.
- Main-process code changes (`src/main/`, `src/services/`, adapters) need a full dev-app restart; the renderer hot-reloads but the main process keeps the old code. Restart only your own dev app, and report it.
- Worktree setup runs `scripts/setup-worktree.mjs`. While `.patchdesk-dev/setup-running` names a live PID, wait and do not run `pnpm install`. Read `.patchdesk-dev/setup-failed` before debugging module errors.
- Keep the dev console and the raw log (`patchdesk.jsonl` in the dev data directory) visible while you work.
- Package only when asked, when the change is packaging-specific, or when distribution proof is required. A packaged app is evidence only for the commit it was built from.
- Insight runs for UI and flow checks use the replay models, free: `PATCHDESK_REPLAY_PROVIDER=1 pnpm dev`, press Refresh models, pick `replay-brief`, `replay-analysis`, `replay-walkthrough` or `replay-guide` (Codex CLI account). They replay `fixtures/replay/` and fit only the head of kwanpham2195/patchdesk#883, a draft kept open as the fixture (Insight runs refuse a closed pull request). Drift logs a reason to `$TMPDIR/patchdesk-replay.log`. Re-record with `PATCHDESK_REPLAY_RECORD=<dir>`, then `node scripts/replay/scrub-recordings.mjs`.
- Insight runs where provider behaviour is the subject spend the maintainer's provider account. Ask before a paid run, pick the model in the run dialog rather than changing the stored preference, and check the provider before Start, because selecting an Insight loads its saved provider. If a model is missing, press Refresh models.

## Code and Testing Conventions

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Comments preserve non-obvious intent, invariants, trade-offs, or external constraints. Prefer one sentence explaining why; let code describe what and how. The codebase still carries long comments from before this rule; they are not a pattern to copy.
- Documentation ownership: ADRs record durable decisions and consequences; code comments explain local constraints; commit messages record change history. Link to the owning source instead of repeating it. When a later ADR changes current guidance, add a supersession note to the earlier ADR and keep its decision intact.
- Keep UI and MCP as thin adapters over the same service. Put shared decisions, validation, and result shaping in domain or service code; see `docs/architecture.md`.
- `process.env` is read only in the owner modules listed in `.oxlintrc.json`; owners await the login-shell import before reading imported values (ADR 0038).
- Check `node_modules` for external API types; do not guess.
- Add bounded, privacy-safe diagnostic logs at important transitions and failure boundaries so later debugging can identify the failing stage without reconstructing the incident. Use fixed reason codes and existing correlation. Preserve the first observed failure before cleanup, distinguish failures at separately awaited cleanup stages, and keep cleanup errors from replacing the original failure. Distinguish observation from root cause. Never log credentials, prompts, source bodies, raw tool arguments or provider prose; logging failures must not change business outcomes. Use existing log owners and retention rather than inventing another telemetry system.

## Testing

- Test observable behaviour at the lowest layer that can prove the contract.
- Follow the verification order above: no unit-test work before final verification without an explicit exception. Necessary repairs to existing tests belong in final verification. New scenarios or expanded coverage require separate approval even then. This policy applies only to Patchdesk.
- No `renderer` tests until asked.
- Write one scenario per test, with as many assertions as needed to prove its relevant outcomes. Separate scenarios with different preconditions or actions; do not split one scenario per assertion.
- No tautological tests. Tests must survive internal refactoring that preserves the contract.
- Control nondeterminism with fixed clocks, seeded data, and controllable promises where needed.
- Playwright (`tests/browser/`): end-to-end journeys and things only a real browser shows. Keep one or two tests per journey; do not cover every scenario.
- Before adding a test, find the existing owner of the behaviour and extend it where appropriate.

## Ways to hurt yourself

Lessons from past sessions that code cannot enforce. Each one cost a wasted pass at least once.

Dev app:

- `pnpm dev` dying with "The requested module 'electron' does not provide an export named 'BrowserWindow'" means `ELECTRON_RUN_AS_NODE=1` leaked from an agent harness into the shell or terminal server. Unset it there and restart.
- A running Patchdesk holds `app.requestSingleInstanceLock()`; a second instance opens CDP and quits with no error. When the CDP port "never comes up", look for the older process first. `pnpm dev` uses its own Electron profile, so an installed Patchdesk does not hold its lock.
- An unpackaged `pnpm dev` keeps its own config, data and cache under `patchdesk-dev` roots; the installed app uses the `patchdesk` roots. A fresh dev profile is empty: run `pnpm dev:copy-profile` (it refuses over an existing dev config without `--force`). `PATCHDESK_DEV_SHARED=1 pnpm dev` runs against the installed roots, for a check that needs the real store. A separate `--user-data-dir` does not change these roots.
- After a renderer `.ts` -> `.tsx` rename, restart `pnpm dev`. Vite's transform cache keeps the old import path, the lazy route fails on MIME, and `agent-browser reload` does not clear it.
- After a change that adds or removes a Tailwind utility class, reload rather than waiting on HMR; Vite's regenerated CSS can fail to reach the renderer and leave the stale rule.
- In the dev app, macOS may list desktop notifications under Electron. Check the dev log for a `shown` event before diagnosing a missing banner as an app defect.

Driving the app over CDP:

- `location.reload()` is swallowed by this app: a `window` global survives it. Reload with `agent-browser reload` (CDP `Page.reload`). Fixture hashes route only on a full load.
- When several sessions drive one CDP port, each passes its own `agent-browser --namespace <name> --cdp <port>`; without it they rebind the shared daemon and clicks land on another session's target. A namespace is not a named session.
- Use the default `agent-browser` session: named sessions call `Target.createTarget`, which Electron's CDP does not implement, and `tab new` fails the same way. After `tab_gone`, run `tab list --json`, find the `http://localhost:5173/` target's `targetId`, and run `tab <targetId>` to rebind.
- Base UI `Select` opens with focus then Enter, not a click. If a pointer-level command stalls, use `eval` to scroll the element.
- Before a live check, `agent-browser eval 'document.visibilityState'` must say `visible`. A covered or off-screen window drops CDP input while `click` still prints Done, and Base UI dialogs never finish closing.
- Inline finding cards on the Diff tab are slotted into `<diffs-container>` only while their row is in the render window; scroll `.review-diff-viewport`, not the card.
- Behaviour that needs a second GitHub actor (someone else's last comment, a push while away) cannot be self-verified live. Say so and name the state a reviewer should check.

Main process and GitHub:

- Insight evidence validity comes from the host-held recursive tree index; concatenating `diff/` files in `files.json` order must reproduce the captured patch hash.
- `http.Server#close()` waits for keep-alive sockets forever; `local-api.ts` calls `closeAllConnections()`. A Playwright teardown that "times out at 30 s with no failing assertion" is this, not a slow test.
- GraphQL rate-limit exhaustion arrives as HTTP 200 with `errors[].type === "RATE_LIMITED"`; classify it there, not from the status code. Free-text GraphQL variables go as `kind: "string"`, or an all-digit search is sent as an Int.
- A write is `rejected` only on a refusal GitHub actually returned. Network errors, timeouts, 5xx, and unparseable success bodies are outcome-unknown: keep the operation locked for reconciliation (ADR 0035), and match recovery evidence by body and anchor, never "any comment created after".
- A confirmed write stays confirmed when a later bookkeeping step (journal append, cache write) fails; log and continue, never re-lock or re-offer it.

Process:

- Every change goes through a PR, including static copy, alerts, messages, and instructions. Behaviour changes include before/after screenshots in the body (`before-and-after` skill). Prompt and schema changes are reviewed in chat first.
- Throwaway PRs are always fine for live checks, including writes. Real PRs follow the scoped write approval under Standing authorization.
- `Closes #n` auto-closes only the first number after it; repeat the keyword per issue. A PR that fixes an issue says `Closes #n` in its body, and after it lands `gh issue view <n> --json state` must read `CLOSED`. A CHANGELOG citation alone closes nothing. Before fixing an old issue, check CHANGELOG and `git log` for its number.
- Once an action is approved, do not re-ask for its sub-steps.
- After live verification passes and before merging, get one final independent blocker-focused review for changes to storage, GitHub writes, locking, or the main process, and for PRs over 300 changed lines. Smaller renderer or copy PRs need a final self-review. Do not insert interim review rounds. Make one fix pass for blockers, then gate and land; list skipped nits in the recap. Report a test-count change against its baseline, not as a raw total.
- In agent shells, `cp` may be interactive. Use `command cp -f` when restoring over an existing file, then verify the diff.

## Standing authorization

- When the maintainer approves execution of a plan or multi-issue program, record its scope, authorized actions, delegation budget, and completion condition in the owning plan. Continue approved slices without asking to proceed; do not exceed the plan or harness limit without approval.
- Read-only screenshots need no additional approval. An approval to draft or review a plan does not authorize its execution.
- Pushes, real-PR creation and updates, and merges are authorized across slices only when the approved execution plan explicitly names those actions and the slices they cover. The parent performs those writes after required gates and reviews. Otherwise ask before each outward write. Ask before removing code that looks intentional, changing scope, or taking a new destructive action; repair failures caused by approved work and rerun without another pause. Stop for unrelated failures, repairs outside scope, or required human review.

## Git

Multiple AI sessions may be running in this checkout at the same time, each modifying different files. Git operations that touch files outside your own changes will stomp on other sessions' work.

- Only commit files YOU changed in THIS session. Stage explicit paths (`git add <path1> <path2>`), and run `git status` first to verify.
- For accepted authorized changes, commit each phase or milestone after final verification and report the SHA. Before that point, preserve scoped work and report checkpoints without running test-bearing hooks early.
- Message format: informative and concise.
- Never run (they destroy other agents' work or bypass checks): `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.
- On rebase conflicts, resolve only files you modified. If a conflict is in a file you did not modify, abort and ask. Never force push.
- Stop for a user-requested human review, an explicit pause, a decision the plan does not cover, an unrelated or out-of-scope gate failure, or a GitHub write that lacks scoped approval. Name the review, pause, decision, or blocker; "Continue with the next step?" is not a stop.

## Skills

Use the named skill when its trigger matches the task. Read the skill file before acting; it is the canonical workflow.

- `code-review`: at final verification after live checks pass, before handoff or landing of changes to `src/`. Do not run interim formal reviews or launch interim review subagents. Final verification also runs each `.agents/review-checks/` check whose globs match the diff, as a low-effort subagent beside the blocker review (see its README).
- `delegated-execution`: substantial exploration, work that spans several files, or several subagents.
- `react-doctor`: finishing React work or checking React diagnostics before handoff.
- `diffs`: working with `@pierre/diffs`, code views, patches, or review surfaces.
- `trees`: working with `@pierre/trees` file trees.
- `shadcn`: adding, debugging, or composing shadcn/ui components.
- `agent-browser`: live browser or Electron verification over CDP.
- `issue`: every bug, request, decision, or idea worth tracking goes to GitHub Issues through issue intake and handoff.
- `pr`: pull request inspection, updates, CI, and landing.
- `product-description`: a user-visible behaviour change updates its page under `docs/product-description/`; read that folder's README.md and goal.md before writing.
- `librarian`: caching or consulting an upstream repository or dependency source.
- `update-changelog`: before editing a changelog.
- `release`: cutting or publishing a release, bumping the Homebrew cask, or installing the latest version. Repo skill in `.agents/skills/release/`.
- `run-program`: batching issues into a tracking issue, or running or resuming one. Repo skill in `.agents/skills/run-program/`.

## References

Shipped types for a dependency are in `node_modules/<package>`. For upstream source, use the public repositories:

- Codex app-server protocol: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- `@pierre/diffs` and `@pierre/trees`: <https://github.com/pierrecomputer/pierre> (the `diffs` and `trees` skills cover usage)

## Memory

- `docs/product-description/glossary.md` owns Patchdesk vocabulary and words to avoid. Read it before naming a domain concept and use its terms in issues, proposals, tests and comments; update it instead of creating a root `CONTEXT.md`. Read the ADRs that govern the area; if a proposal conflicts with one, name the conflict and the decision to revisit.
- Put durable project rules and preferences here so every agent harness can use them. Keep dated project status and scoped authorizations in the workspace context or tracker; check current state before relying on historical permissions.
- The issue tracker is GitHub Issues on this repository. For repository-authored specs, state the problem, then use `Why it matters`, `Scope`, and `Verification`; add `Open questions` and `Confidence` only when a real decision is pending. Repository-local task, research and plan folders are not used. `CONTRIBUTING.md` lists the issue labels.
- Read the summaries in `docs/product-description/` and `docs/product-description/bug-triage.md` before feature inventory or roadmap work. They describe shipped behavior and known gaps. Check the Not planned section of `ROADMAP.md` before proposing features, and update it when an issue moves between sections or a direction decision changes. Local Review is for reviewing agent changes, not for committing, pushing, or opening pull requests; read ADR 0051 before proposing changes to that workflow.
- Ask before removing or replacing README screenshots, adding light-theme variants, or starting another screenshot capture round; the existing dark-theme tour was deliberate.
