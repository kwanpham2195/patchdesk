# Repository Guidelines

## Non-negotiables

Subagents do not read this file. Paste these five lines into every brief.

- Commit each accepted slice with explicit paths, and end the report with the SHA.
- A renderer change is finished only after you looked at a screenshot of the affected screen over CDP.
- Run `pnpm check` before handoff.
- No compatibility shims or fallbacks unless asked for.
- Ask before removing code that looks intentional.

## Project Structure

See `CONTRIBUTING.md` (codebase map) and `docs/architecture.md` (layers) for the full picture.

## Conversational Style

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

Before starting any task, make sure the dev log tails are live in herdr:

- Log tail tab: raw `patchdesk.jsonl` (tail of `~/.local/share/patchdesk/logs/patchdesk.jsonl`).
- Dev tab: the `pnpm dev` console (renderer/api log lines and HMR output).
- If either pane is gone or idle, start/restart it before doing the work.
- Main-process code changes (e.g. `src/main/`, `src/services/`, adapters) need a full dev-app restart: renderer hot-reloads but the main process keeps the old code.

- Verification commands live in `CONTRIBUTING.md`. `pnpm check` (typecheck,
  renderer error surfaces, root test suite, staged lint) is the pre-handoff
  command.
- Drive the running app with `agent-browser` over CDP. Read-only by default; ask before any write. A renderer change is finished only when you have looked at a screenshot of the affected screen taken after the change loaded; an API response, a log line, or a passing test is not live verification, so say which you have.
- CDP: `pnpm dev` listens only with `REMOTE_DEBUGGING_PORT` set. Port 9233 is the maintainer's app; a session that needs its own takes `REMOTE_DEBUGGING_PORT=924N` and its own user-data dir, never kills a process it did not start, and asks before restarting 9233. `pnpm cdp:ready` checks the port: run it before claiming anything about the running app, before reporting, and before delegating a live-verification slice.
- Package only when asked, when the change is packaging-specific, or when distribution proof is required. A packaged app is evidence only for the commit it was built from.
- Insight runs started for testing (Brief, Analysis, Walkthrough) spend the maintainer's provider account. Use a low-cost model such as `gpt-5.6-luna` on the Codex CLI account provider, not `gpt-5.6-sol`; pick it in the run dialog rather than changing the maintainer's stored preference.
- Subagent models by role, for Claude Code. Names drift; the split is the rule.

  | Role | Model |
  | --- | --- |
  | Exploration and research | `sonnet` |
  | Implementation | `implementer` agent (Opus, low effort, in `~/.claude/agents/`; pass `model: opus` to the Agent tool when a session does not list it) |
  | Review | `fable`, default effort |

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
- No assistive-technology tests: no axe scans, no screen-reader narration
  checks, no forced-colors or reduced-motion checks (ADR 0034).
- Before adding a test, check whether one already asserts the behaviour at a
  lower layer or in another file. Duplicates are deleted, not kept "for
  safety".

## Git

Multiple AI sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Commit each accepted phase or milestone after its verification gate, and report with the SHA. A report may not say "uncommitted" or list pending work while your own files are dirty.
- Message format: informative and concise.

Stopping:

- Stop only for a decision the plan does not cover, a failed gate, or a GitHub write, and name the decision you are waiting on. "Continue with the next step?" is not a stop. The `delegated-execution` skill has the full rule.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Skills

Use the named skill when its trigger matches the task. Read the skill file before acting; it is the canonical workflow.

- `code-review`: before any handoff that changed `src/`. Run it yourself; do not wait to be asked.
- `delegated-execution`: work that spans several files or several subagents.
- `react-doctor`: finishing React work or checking React diagnostics before handoff.
- `diffs`: working with `@pierre/diffs`, code views, patches, or review surfaces.
- `trees`: working with `@pierre/trees` file trees.
- `shadcn`: adding, debugging, or composing shadcn/ui components.
- `agent-browser`: live browser or Electron verification over CDP.
- `herdr`: dev servers, log tails, watchers, and named panes.
- `github`: GitHub issues, pull requests, reviews, CI, or releases. Use its more specific leaf skill when applicable.
- `issue`: every bug, request, decision, or idea worth tracking becomes an issue through this skill, and triage runs through it too, unless the user says not to.
- `product-description`: a user-visible behaviour change updates its page under `docs/product-description/`; a new page, checklist, or triage entry follows the skill's "Resuming and extending an existing repo" steps. Read that folder's README.md and goal.md before writing.
- `librarian`: caching or consulting an upstream repository or dependency source.
- `update-changelog`: before editing a changelog.

## References

- Codex app-server protocol reference: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md> (cache it with `$librarian`).

## Memory

- Put stand-alone research notes in `.agents/research/`. Use `.agents/tasks/`
  for task packages whose specification and design come first, and
  `.agents/PLANS/` only for long-running execution plans.
- A completed task package is closed reference material. Do not add research,
  plans, or implementation artifacts to it; route follow-up work using the
  locations above.
- Update the plan file in the same commit as the work it describes.
- Run `node .agents/PLANS/program/program.mjs status` before reporting
  progress on the program.
