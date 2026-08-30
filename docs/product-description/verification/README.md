# Hand verification

The feature documents were drafted from committed source and tests. This directory is the protocol for checking them against the running default Patchdesk desktop app, one observable claim at a time. No document is verified by source inspection, automated tests, or this package alone.

## What is here

| File | Covers |
| --- | --- |
| [foundations-and-settings.md](foundations-and-settings.md) | Foundations, the workspace-profile pilot, and Settings |
| [pull-requests.md](pull-requests.md) | First run and the Pull requests screen |
| [review-workbench.md](review-workbench.md) | Conversation, diff, inline conversations, pending review, and merge |
| [insights-and-cross-cutting.md](insights-and-cross-cutting.md) | Insights plus cross-cutting safety, recovery, privacy, and desktop behavior |

Each checklist has one table per document. Every row has a stable ID, priority, required condition, one claim linked to its owning section, precise setup, numbered steps, an observable expected result, and a Result column. Results remain `—` until a live pass records `pass`, `fail`, or `blocked`.

Priorities: **P1** is an established fact, a claim many documents depend on, or a suspected defect; **P2** is an ordinary behavior; **P3** is a number, color, or timing detail.

## How to run a pass

1. Bring up the default macOS app with `REMOTE_DEBUGGING_PORT=9233 pnpm dev`. Keep the raw app log tail visible at `~/.local/share/patchdesk/logs/patchdesk.jsonl` and drive the window through `agent-browser` over CDP 9233.
2. Confirm the running application-source commit with `git rev-parse --short HEAD` in `/Users/kwanpham/Work/patchdesk`. The documents target commit `3100615`; a different source commit is drift, not evidence against these claims.
3. Keep this package and the linked product document open beside the app. Read the linked section before each item; the checklist row is a test summary, not a replacement for the document.
4. Use a clean dedicated Patchdesk profile and disposable test repository where possible. Record the profile, host, repository, pull-request numbers, local roots, and relevant preference state in the Result note without recording credentials or tokens.
5. Work through P1 items across all files, then P2, then P3. Reset only through safe UI actions between sections. Do not use production repositories or personal Review history for destructive or write checks.
6. Record `pass`, `fail`, or `blocked` in the Result column. Add a short note for anything other than a clean pass, including the exact visible state, profile, target, and evidence path.
7. File every fail in `bug-triage.md`. If the entry exists, add a Status line quoting the checklist ID; otherwise add the ID under Raised by. A mismatch can be a documentation fix rather than a product defect, so state which it is.
8. Change a coverage row in [`../README.md`](../README.md#coverage) from `drafted` to `verified` only after every P1 and P2 item for that document has passed or has been filed.

## Safe identities, writes, and destructive actions

- Use a dedicated local workspace profile with a non-production GitHub host or repository. The profile may name a test account, but Patchdesk must resolve authentication externally; never paste a token into Settings, a test fixture, a log, or a Result note.
- Read-only checks can use a fixture repository or an existing read-only Pull request. They must not submit comments, Finish review, merge, alter metadata, or start provider work unless the checklist row explicitly says that a separate disposable setup and consent are required.
- GitHub-write checks require an explicit disposable repository, a known pull request, confirmed permission, a current Fresh Review, and a cleanup plan. Record receipts and outcomes; never retry an outcome-unknown write until GitHub has been checked.
- Cleanup checks require a disposable profile and local data backup or a throwaway test root. Clear cache and Clear local review data are destructive local operations; do not run them during an ordinary verification pass without explicit owner approval. This package intentionally does not run them.
- Insight checks can spend provider usage. Use the low-cost configured provider only when a row explicitly requires a run, disclose the provider and model in the Result note, and never use a provider run merely to check fixed layout or copy.

## Required conditions

- **mouse:** real pointer clicks in the macOS window; use it for visible controls and focus placement.
- **keyboard:** real key presses in the focused window; synthetic key events or a second tab are not proof of shortcut routing.
- **desktop menu:** the native application menu and titlebar commands, not an equivalent button click.
- **offline/read failure:** use a disposable environment or controlled test setup that makes the requested dependency unavailable; DevTools offline alone does not reproduce every in-flight network failure.
- **provider:** a configured Insight provider and disposable represented Review; provider runs cost usage and need explicit approval.
- **write:** a disposable GitHub repository and pull request with known permissions; never use a production target.
- **destructive:** a disposable profile/data root and a recorded backup; do not rely on Clear cache or Clear local review data to preserve recoverability.
- **macOS window:** the actual app window, including native close/quit behavior; an occluded or background window cannot prove visible focus or timing.

## Driving the product from a console or script

Use `agent-browser --session patchdesk-dev --cdp 9233` for real clicks, key presses, screenshots, and visible text. The CDP connection can read the current page and help capture evidence, but it cannot prove native macOS close prompts, off-screen focus, or how a transition feels when the window is occluded. Synthetic DOM events cannot replace real keyboard or menu input for shortcut claims.

The app's local API and raw log are useful for setup and evidence only when a checklist row names them. They must not be used to gesture through a UI claim. A local API response can confirm a persisted state or returned receipt, but it cannot prove what the maintainer saw or where focus landed.

## Results so far

Nothing yet. No live app, GitHub write, merge, cleanup, or Insight run was performed while drafting this package. Every Result in the four checklist files is `—`, and no document is marked verified.
