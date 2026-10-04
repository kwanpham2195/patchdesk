# Guide: maintain the Patchdesk product description

Describe what maintainers see and do in the default Patchdesk macOS app. Keep the language short and plain. Keep behavior precise.

## Read first

Read these files before editing:

1. `README.md` for scope, structure, and coverage.
2. `glossary.md` for product terms.
3. `foundations/task-lifecycle-and-interruption.md` for task phases and interrupts.
4. `settings/workspace-profile-editor.md` for the feature-page style.

Read the feature page and its owning foundation before making changes.

## Source and scope

Use the committed application source named in each page's footer. Do not use uncommitted source as evidence. Read the UI flow, domain rules, services and routes, matching tests, visible copy, and defaults that affect the behavior.

Describe the default app on supported Apple Silicon macOS. Exclude fixture routes, release packaging, unsupported platforms, screen readers, touch, pen, and exact model-generated wording. Change files only under `docs/product-description/`.

## Writing rules

- Describe what the maintainer sees and does, not how the code works.
- Use short sentences, common words, and active voice.
- Keep one main idea in each sentence. Split sentences that carry several steps or conditions.
- Use glossary terms. Add a definition before using a new product term.
- Explain surprising behavior plainly. Put suspected defects and unverified behavior under **Open questions and verification**.
- Put technical details in a `> Technical note:` block only when they change what the maintainer should expect.
- Link to the page that owns a behavior. Do not repeat its full explanation.
- Do not add release history. The repository `CHANGELOG.md` owns it.

## Feature page structure

Keep the eight sections and their order from `README.md`:

1. Summary.
2. The simple case.
3. The task, event by event.
4. Variants.
5. Cancel and interrupt.
6. Interactions with other systems.
7. Edge cases.
8. Open questions and verification.

Use these five task phases: arrive, leave unchanged, begin an action, while the action runs, and settle. Use one small Mermaid `stateDiagram-v2` per interaction.

Variants and interrupts use tables split into **Before the action runs** and **While the action runs**. Keep the fixed rows and their order from `README.md`. Fill every cell, including cells that say `No effect.` Cover cross-cutting concerns in the listed order, even when a concern has no effect.

End each feature page with its open questions, then the source commit and any scoped follow-up source commit. State which claims have not had a live check. A live check proves only the source version it used.

## Product rules to preserve

The foundation pages own these rules. Link to them instead of copying their full details:

- The app has two destinations: Pull requests and one Review workbench. Settings is an overlay.
- A Review spans pull-request revisions. Each Review session represents one exact revision.
- GitHub writes need a current, non-terminal Review session and the action's permission and recovery checks. Review-content writes also need Fresh evidence and a current-head check; metadata writes use the current-session gate. Patchdesk never retries an uncertain write automatically; related writes stay locked until reconciliation.
- GitHub's pending review is the authoritative editable Review draft.
- Insights stay tied to their represented revision and do not write to GitHub on completion.
- Workspace controls save individually. Rejected values do not replace saved values.
- Task state belongs to its feature. There is no global cancel command or operation queue.

See `foundations/` and `cross-cutting/` for the full behavior and safety rules.

## Verification and triage

Use the checklists in `verification/`. Each row must describe one observable claim with setup, steps, expected result, and a Result field. Leave Result as `—` until a live check runs. Source, tests, and automation alone do not verify a desktop claim.

A page is `verified` only when all its P1 and P2 checks pass or the failures are filed in `bug-triage.md`. Record suspected defects there. Record non-defect friction in `ux-friction.md`. Keep a disposition for each finding. Do not file issues or publish findings without approval.

## Editing and completion

- Keep the file list and coverage table in `README.md` accurate.
- Run `python3 ~/.claude/skills/product-description/references/check-links.py docs/product-description` after changing links or headings.
- Before handoff, review the diff for lost behavior, stale history, broken links, and inconsistent terms.
- Run `pnpm check` before completing an authorized change. Stage and commit only files under `docs/product-description/`, using explicit paths.

The description is complete when every listed page exists, the links and coverage agree, the checklists and triage are present, and verification status is reported honestly.
