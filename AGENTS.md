# Repository Guidelines

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

- Verification commands live in `CONTRIBUTING.md`.
- For live verification of the running app, drive it with `agent-browser` over CDP 9233. Read-only by default; ask before any write.

## Code and Testing Conventions

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

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
- Message format: informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## References

- Codex app-server protocol reference: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md> (cache it with `$librarian`).

## Memory

- Put stand-alone research notes in `.agents/research/`. Use `.agents/tasks/`
  for task packages whose specification and design come first, and
  `.agents/PLANS/` only for long-running execution plans.
- A completed task package is closed reference material. Do not add research,
  plans, or implementation artifacts to it; route follow-up work using the
  locations above.
