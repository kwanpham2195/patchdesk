---
created_at: 2026-07-26
status: draft
scope: Plannotator's Guided Review feature (data model, server, client, takeover, persistence, failure handling)
canonical_packet: narrative-walkthrough
repo: github.com/backnotprop/plannotator
sources:
  - adr/decisions/006-guided-review-first-class-feature-20260702-192821.md
  - adr/specs/guided-review-20260702-195351.md
  - adr/recap-guided-review-20260702-220407.md
  - packages/shared/guide.ts
  - packages/shared/guide-store.ts
  - packages/server/guide/guide-review.ts
  - packages/server/review.ts (lines 220-260, 923-986, 1288-1330, 1430-1524)
  - packages/server/agent-jobs.ts (lines 68-74, SERVER_BUILT_PROVIDERS)
  - packages/review-editor/App.tsx (takeover, badge, auto-open, focus)
  - packages/review-editor/components/guide/GuideScreen.tsx
  - packages/review-editor/components/guide/GuideEmptyState.tsx
  - packages/review-editor/components/guide/GuideGenerating.tsx
  - packages/review-editor/components/guide/GuideView.tsx
  - packages/review-editor/components/guide/GuideSectionCard.tsx
  - packages/review-editor/components/guide/GuideDiffSection.tsx
  - packages/review-editor/hooks/guide/useGuideData.ts
  - packages/review-editor/hooks/guide/useGuideLaunch.ts
  - packages/review-editor/demoGuide.ts
---

# Plannotator Guided Review — research

## Question

What is the Guided Review feature, how is it wired end-to-end (trigger, generation, validation, takeover, persistence, failure), and what design constraints drove the implementation?

## What it is

A **second primary reading mode for the code-review app.** A "Guide" badge in the header toggles a screen takeover that replaces the file tree + center dock with a Notion-like chaptered walkthrough of the same diff. Each chapter pairs a prose overview with the actual `DiffViewer` instances for the files it covers, so the reviewer can annotate in place. Annotations made inside the guide flow into the same `CodeAnnotation` state and the same Send Feedback payload as ones made in the normal diff view.

ADR-006 (`adr/decisions/006-guided-review-first-class-feature-20260702-192821.md`) frames it as "a second primary reading mode, not a new subsystem." The recap records that the implementation used 4 research spikes, 4 implementation phases on disjoint file sets, an adversarial self-review, and a 13-item fix pass before builds went green.

## User-facing flow

1. **Trigger.** "Guide" pill badge in the header next to the file-tree toggle (`App.tsx:2788-2808`). Shortcut `Mod+Shift+G`. First-visit pulsing hint dismisses on click.
2. **Takeover.** Click sets `guideOpen = true` (`App.tsx:248`). File tree branches and center dock are CSS-hidden; the dock itself stays mounted so its layout/scroll state survives toggling closed and open (`App.tsx:3385`). Right sidebar is untouched. A `GuideScreen` renders in its place.
3. **Auto-open.** When a `guide`-provider job completes, an effect with a ref-Set dedupe flips `guideOpen` and stores the job id (`App.tsx:1034-1054`). If the user has switched to a different review context, auto-open is suppressed and re-fires when they return — matches the existing tour pattern.
4. **Screen branches** (`GuideScreen.tsx:80-218`): running → `GuideGenerating`, completed → `ActiveGuide` (calls `useGuideData` + `GuideView`), failed → `GuideEmptyState` in failure-recovery mode, nothing yet → plain `GuideEmptyState`. Choice is "context-scoped" via `jobMatchesReviewContext` so a guide launched against PR A does not appear while reviewing PR B.
5. **Empty state** is the launch page: heading, paragraph, "Model defaults" card (engine / model / effort / reasoning / thinking pickers, persisted via `useAgentSettings`), primary Generate button, plus a "Previous guides" list backed by `GET /api/guides`.
6. **Generation** routes through the same `launchJob` from the single `useAgentJobs` instance — no second SSE connection.
7. **Failure recovery** offers two paths once the failed job's raw output is captured (`/api/guide/:jobId/output`):
   - **Fix output** — launches a low-effort repair job via the same engine, seeded with the captured payload (`{ provider: "guide", label: "Guide Repair", repairOf: failedJob.id }`).
   - **Show output** — `<textarea>` with the raw payload, editable, submitted via `POST /api/guide/:jobId/submit`.
8. **Reading.** `GuideView` renders title + intent + sections + trailing "Everything else" bucket for `unplacedFiles`. `GuideSectionCard` is the two-column chapter (440px sticky overview on the left, diffs on the right); `Reviewed` checkbox collapses the card with peek-to-re-expand that never un-marks it. File chips on the left click through the `guideRevealFile` channel to expand and scroll to the matching diff.

## Data model

`packages/shared/guide.ts`:

```ts
export interface GuideDiffRef { file: string; summary?: string; }
export interface GuideSection { title: string; overview: string; diffs: GuideDiffRef[]; }
export interface CodeGuideOutput {
  title: string; intent: string;
  sections: GuideSection[];
  unplacedFiles?: string[];
}
export type CodeGuideData = CodeGuideOutput & {
  reviewed: boolean[];
  saved?: boolean;   // persisted on disk
  moved?: boolean;   // stored headSha ≠ current head
};
```

`CodeGuideData` is the wire shape returned by `GET /api/guide/:jobId`.

## Server

### Module: `packages/server/guide/guide-review.ts`

`createGuideSession()` returns the in-memory store and the hooks the review server plugs into `agent-jobs.ts`:

- `guideResults: Map<jobId, CodeGuideOutput>` — validated outputs.
- `guideReviewed: Map<jobId, boolean[]>` — per-job per-section state, in memory.
- `failedPayloads: Map<jobId, string>` — raw capture for any job whose output failed to parse or validate.
- `launchChangedFiles: Map<jobId, string[]>` — the changed-file set snapshotted at LAUNCH time (not completion), so a mid-generation PR/diff switch never invalidates an otherwise-valid guide.

### Generation prompts and commands

- `GUIDE_REVIEW_PROMPT` — system prompt. North Star: "organize the diff the way the work was reasoned through, not by path or diff size." Core first, consequences next, glue grouped last. Explicit "guide, not review" calibration: orient, don't critique. Hard constraints: 2-6 sections, no em-dashes, no emoji, every changed file in exactly one of `sections[].diffs` or `unplacedFiles`.
- `GUIDE_SCHEMA_JSON` — JSON schema for `CodeGuideOutput` with `required: ["file", "summary"]` on each diff ref.
- `buildGuideUserMessage` — composes the per-launch user message, including a `Changed files` block with `+additions/-deletions` so the model plans placement against the real file set. Workspace variant for multi-repo mode.
- Four engine command builders, two strategies:
  - **Claude** — `buildGuideClaudeCommand` uses `--json-schema GUIDE_SCHEMA_JSON`, `--output-format stream-json`, an `allowedTools` list that includes `gh pr view` and `gh issue view` (the guide prompt follows linked issues from PR bodies), and explicit `disallowedTools` excluding `Edit`, `Write`, `WebFetch`, `WebSearch`, and shell execution. Output parsed from the last NDJSON `result` event.
  - **Codex** — `buildGuideCodexCommand` writes the schema to `${PLANNOTATOR_DATA_DIR}/guide-schema.json` once and passes `--output-schema` to `codex exec` along with `-o <tempfile>`. Parsed via `readGuideOutputFile` + JSON.parse.
  - **Marker engines (Cursor, OpenCode, Pi, Copilot)** — no schema flag exists, so the prompt appends `buildGuideMarkerOutputContract(nonce)` describing the same shape in prose + example, and the model returns a `<plannotator-guide id="{nonce}">…</plannotator-guide>` block. `composeGuideMarkerPrompt` is the marker analogue. The nonce is generated per job and recovered from `job.prompt` at parse time — same discipline as the tour marker path.
- **Repair prompts** — three builders, one per engine family. All share `buildGuideRepairFraming`: "Output ONLY the corrected JSON. Fix structure and syntax; NEVER change the content." Repair is a mechanical JSON-syntax fix, not a re-analysis.

### Output parsing and mechanical repair

- `parseGuideStreamOutput` (Claude) — line-buffered NDJSON, last `result` event's `structured_output`. Secondary repair path: if the last line is truncated mid-stream but contains `"structured_output":`, slice the value and run `repairGuideJsonText` on it.
- `parseGuideFileOutput` (Codex) — read tempfile (always unlink in `finally`, even on read failure), then `parseGuideOutputText` (try parse, fall back to repair).
- `parseGuideMarkerOutput` (Cursor/OpenCode/Pi/Copilot) — `reduceMarkerStream` to canonical text, `extractLastMarkerBlock` with the nonce-scoped open/close, parse, fall back to repair.
- `repairGuideJsonText` — six progressively-aggressive fixups on the raw text, `JSON.parse` retried after each, first one yielding a non-empty `sections` array wins:
  1. trim
  2. strip markdown code fence
  3. slice from first `{` to last `}`
  4. strip trailing commas outside string literals
  5. close unbalanced brackets (with the "truncated mid-string" fixup — append `"` before closers if the literal is still open)
  6. strip trailing commas once more (step 5 can introduce a new one right before the closer it just appended)
- The bracket and comma helpers are character-by-character scanners that respect string-literal boundaries — the comment on `stripTrailingCommasOutsideStrings` notes a naive regex would silently rewrite overview text like `"we removed a, }"`.

### Sanitization and validation (fail-closed)

- `sanitizeGuideSection` drops sections with nothing of value; coerces each diff to `{ file, summary? }`; gives a diffs-only section a default "Untitled section" title rather than dropping it (dropping would silently orphan its files from the coverage story).
- `validateGuideOutput(raw, changedFiles)` is the fail-closed gate. Runs against the **launch-time changed-file set** (snapshot captured in `onJobComplete`):
  - `diffs[].file` not in the changed set → ref dropped entirely
  - A file placed twice → first placement wins
  - A section that lost all its diffs to validation is dropped unless it was already zero-diff with real overview text
  - `unplacedFiles` is computed: every changed file not yet placed, merged with any model-provided unplacedFiles that are real changed files and not already placed
  - Zero surviving sections → `{ error: "No sections survived validation" }` (fail closed)
- `validateGuideOutput` is shared by `onJobComplete` (automatic ingest) and `submitManualOutput` (manual repair paste) so a malformed model output and a malformed human-pasted output are held to the same bar.

### Stash failed payloads

`stashFailedPayload` captures the best raw candidate the parser saw — for Claude, the `structured_output` value of the last `result` event; for marker engines, the recovered marker block (or the raw stdout tail); for Codex, the file contents. Capped at 200 KB. `failedPayloads.delete(job.id)` runs on success, so the manual-repair UI is only offered for jobs that actually failed.

### Review-server integration

- `createGuideSession()` instantiated once per review server.
- `createGuideStoreSession(...)` instantiated with late-bound getters for `getPRInfo`, `getGitCwd`, `getBranchLabel`, `getFallbackDir`, `writesEnabled` — PR/diff/config switches mid-session are reflected in the list endpoint and the `moved` flag.
- `buildCommand` for the guide provider lives in `review.ts:923-986` and calls `guide.buildCommand({...})`. It passes the **launch-time** changed-file list (same `changedFilesSnapshot` mechanism the rest of `buildCommand` uses).
- `onJobComplete` for guide jobs lives in `review.ts:1288-1330`. It calls `guide.onJobComplete({ job, meta, changedFiles: meta.changedFilesSnapshot ?? listPatchFiles(currentPatch)… })` — preferring the snapshot so a mid-generation diff switch doesn't break an otherwise-valid guide.
- `provider === "guide"` is registered in `agent-jobs.ts`'s `SERVER_BUILT_PROVIDERS` (`agent-jobs.ts:68-74`) alongside `claude`, `codex`, `tour`, `cursor`. The capability entry `guide: claude || codex` is computed the same way as `tour`.

### Persistence (`packages/shared/guide-store.ts`, #1112)

- **On disk**: `${PLANNOTATOR_DATA_DIR}/guides/{repo-key}/{id}.json`. `repo-key` is `host__owner__repo` derived from the origin remote URL (or PR url, in PR mode), with a no-remote fallback of `{basename}-{hash8}` — same discipline as annotate mode's per-file history slugs.
- **Envelope shape**: `version, savedAt, label, title, engine?, model?, headSha?, prUrl?, guide, reviewed[]`. `headSha` is the repo HEAD (or PR head sha) at generation time and drives the `moved` flag.
- **Atomicity**: `writeFileSync` to a `.tmp` path then `renameSync` to the final path; reads are best-effort (corrupt files load as "no saved guide").
- **Id whitelist**: `isValidGuideId` rejects anything that doesn't match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` and is ≤160 chars — guards against path traversal since ids arrive from the client on the `saved:{id}` endpoints.
- **Launch-time context capture**: `captureLaunchContext()` is called at job launch and stamped onto the job as `job.guideContext`. At save time, `saveForJob(job, data, launchContext)` prefers the launch-time snapshot over the live getters, so the envelope is labeled with the changeset the guide was *generated against*, not the PR/diff the reviewer switched to while the job ran.
- **Write-through for reviewed state**: when a live job's reviewed state changes via `PUT /api/guide/:jobId/reviewed`, the change is written to the saved envelope via `writeThroughReviewed`, so the persistence is real-time and survives a server restart.
- **Listing**: `listSaved()` returns `[{ id, label, title, savedAt, progress: { reviewed, total }, moved }]`, with `moved = !!stored && stored !== current`. The "Previous guides" UI and the `/api/guides` row schema use this exact shape.

### Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/guide/:jobId` | Live job or `saved:{id}` — returns `CodeGuideData` |
| PUT | `/api/guide/:jobId/reviewed` | Per-section reviewed state; live ids write through to the autosaved file, `saved:{id}` ids persist directly |
| GET | `/api/guides` | Repo-scoped list |
| DELETE | `/api/guides/:id` | Remove a saved guide |
| GET | `/api/guide/:jobId/output` | Captured raw output of a failed job (404 if nothing captured) |
| POST | `/api/guide/:jobId/submit` | Manually submit repaired JSON for a failed job; validates against the job's own `launchChangedFiles`; on success the job flips to `done` and the guide is autosaved |

## Client

### Hooks

**`useGuideData(jobId)`** (`packages/review-editor/hooks/guide/useGuideData.ts`)

- Fetches `GET /api/guide/{jobId}`, sets `guide`, `reviewed`, and a `skipNextSaveRef` flag that tells the persistence effect "this seed is not a user toggle, don't PUT."
- Out-of-order guard: every fetch captures a `cancelled` flag, the effect's cleanup sets it; a slow response for an OLDER `jobId` cannot clobber a newer one.
- `toggleReviewed(index)` is a pure functional updater (StrictMode-safe). Writes through the persistence effect via `saveReviewed`, which debounces PUT requests 500ms and uses `keepalive: true` on unmount so a tab close can still flush.
- `retry()` bumps a `refreshNonce` state to re-run the fetch effect without calling `fetchGuide` directly.
- Dev short-circuit: `jobId === DEMO_GUIDE_ID` skips the fetch and renders `DEMO_GUIDE` directly.

**`useGuideLaunch(capabilities)`** (`packages/review-editor/hooks/guide/useGuideLaunch.ts`)

- Reads persisted engine/model settings from `useAgentSettings` (cookie-backed, shared with `AgentsTab`).
- Resolves the effective engine: persisted choice if available, else the first available one.
- Per-engine model catalogs: `cursorOptions` REPLACES the discovered list (it natively includes `auto`); `opencodeOptions` / `piOptions` / `copilotOptions` PREPEND a Default option (so a saved-default user can return to default after picking a concrete model).
- Reconciles stale saved model ids: if a saved value isn't in the current catalog, fall back to the catalog's first entry rather than POSTing a dead id.
- Returns `buildParams(): AgentLaunchParams` — one shape per engine, mirroring `AgentsTab.buildGuideLaunch` exactly.

### Components

`GuideScreen` (root, branches state) → either `GuideGenerating` (live), `GuideView` (done), or `GuideEmptyState` (no guide / failed).

- **Newer-failed-job rule** in `ActiveGuide`: a failed job that lands AFTER `activeGuideJobId` is shown as a slim failure strip ABOVE the still-good guide, with "Fix output" and "Details" actions, plus an `×` that hides it via a ref-Set keyed by id.
- **Failure-state branch** is keyed on `jobId` so per-failure local state (textarea edits, capture probe) never leaks across attempts.

`GuideEmptyState` (launch + failure recovery + previous guides).

- Inline `InlinePicker` with type-to-filter for catalogs above `SEARCHABLE_THRESHOLD`.
- Failure recovery: probe `GET /api/guide/{id}/output` once; on success populate `capturedPayload`/`editedPayload`, render the "Fix output" + "Show output" disclosure. `Submit fixed output` posts to `/api/guide/{id}/submit`; on 200 it calls `onOpenFixedGuide(jobId)`.

`GuideGenerating` (running). Mirrors the future guide layout: header zone shows status, skeleton section cards fill the width below, live log is progressive disclosure ("Show activity") with a 200-line tail.

`GuideView` (the guide itself).

- Title + intent + meta (`N sections`, `M/N reviewed`, `generated by Claude`).
- `Saved` chip when `guide.saved` is set.
- `Generated on a different version of this branch · Regenerate` strip when `guide.moved` is set and `onRegenerate` is provided.
- "Everything else" trailing card renders `guide.unplacedFiles` — the coverage guarantee.

`GuideSectionCard` (one chapter).

- Two-column body: 440px sticky overview on the left, diffs on the right. Sticky column capped at `calc(100dvh - 48px)`.
- `position` is `01 / 04` zero-padded.
- `Reviewed` checkbox collapses the card. A separate "collapse chevron" is the explicit user choice; the override is cleared on toggle so the default relationship (collapsed iff reviewed) resumes.
- `FileChip` shows file name + directory + `+additions/-deletions`, or `outdated` if the ref no longer resolves against the current diff. Click routes through the `guideRevealFile` channel (not bare `scrollIntoView`) because the target may be collapsed.
- "Two SIBLING buttons" comment: a checkbox span cannot be a child of a button (invalid HTML and unreachable by keyboard) — the previous markup is fixed to siblings.
- `overflow-clip` (not `hidden`) on the card: `hidden` makes the card a scroll container, which silently breaks the left column's `position: sticky`.

`GuideDiffSection` (per-file diff inside a guide).

- The annotation-parity piece. Mirrors `ReviewDiffPanel`'s DiffViewer prop bag exactly, with two differences:
  - Annotation handlers are bound to `diffRef.file` explicitly (`onAddAnnotationForFile`, `onAskAIForFile`) instead of resolving the file from the dock's `activeFileIndex`, which has no meaning here (multiple `GuideDiffSection` instances mount at once on one scrolling page).
  - `isFocused` comes from the guide screen's own focus arbiter, not `state.focusedFilePath`.
- `pendingSelection` is gated on `isFocused`: it always originates in whichever viewer the user's pointer is in; without the gate, every OTHER visible guide DiffViewer would also paint the highlight and auto-scroll to it.
- Height is `estimateDiffHeight(file.patch) = clamp(lineCount * 21 + 52, 150, 620)` — tiny diffs render at natural height, huge ones cap and scroll internally.
- Missing file → "no longer in the current diff" chip with an info icon; degrades gracefully, never crashes.
- AI history is gated on `isFocused` so all of them aren't kept in render.

### Annotation parity, in concrete terms

`GuideDiffSection` mounts the same `DiffViewer` from `packages/review-editor/components/DiffViewer.tsx` that the dock uses, with the same prop bag. The handlers it passes are the file-scoped variants already on the review state context (`onAddAnnotationForFile`, `onAddFileCommentForFile`, `onAskAIForFile`, `onStage`). Consequence:

- An annotation made in the guide is indistinguishable from one made in the diff view (`CodeAnnotation` list is shared in `App.tsx`).
- `Send Feedback` exports both in the same payload — no separate `guideAnnotations` array, no separate submission.
- The `reviewed` state is the only guide-specific state. The two states are independent: marking a section "Reviewed" does not mark the file as `viewed`; marking a file as `viewed` does not toggle the section checkbox.

## Takeover mechanics

- File tree branches: each is `{!guideOpen && shouldShowFileTree && isFileTreeOpen && …}` so the file tree is unmounted while the guide is open (cheap; the tree rebuilds fast) but the center dock is CSS-hidden and only the guide `<div>` is mounted.
- `focusedFilePath` is nulled at the source when `guideOpen` is true (`App.tsx:2276`). Every dock panel derives `isFocused` from it, so this one line strips focus claims at the source instead of threading `guideOpen` through every dock panel.
- Guide-side DiffViewers arbitrate focus among themselves via `focusedFile` state in `ActiveGuide`; default seeded to the first section's first resolvable file.
- `setGuideRevealFile(null)` is called in a `useEffect` on `[guideOpen, activeGuideJobId]` so a same-batch state clear never re-fires the reveal effect with a stale target.

## Failure handling

Three nested states:

1. **Run-level failure** (job status `failed` or `killed`, latest in the current context, no `displayGuideJobId`) → `GuideEmptyState` in failure-recovery mode, keyed on the failed job's id.
2. **Mid-generation failure while a previous guide is showing** → slim failure strip in `ActiveGuide` above the still-good guide. Dismissed via a ref-Set keyed by id.
3. **Repair path** (from either): launches a new job with `{ provider: "guide", label: "Guide Repair", repairOf: failedJob.id, engine: failedJob.engine }`. The repair command's prompt is `buildGuideRepairPrompt` / `composeGuideMarkerRepairPrompt`, which is a mechanical JSON-syntax fix with low-effort defaults, not a re-analysis.

When a job's output fails to parse or validate:

- `parseGuide*Output` returns null
- `validateGuideOutput` returns `{ error }` (fail closed)
- `onJobComplete` calls `stashFailedPayload(failedPayloads, job.id, rawCandidate)` and returns `{ summary: null }`
- `agent-jobs.ts` flips the job to `failed` with the error string on it

When the user manually submits corrected JSON:

- `submitManualOutput` re-parses, then `validateGuideOutput` against the same launch-time changed-file set the auto-ingest used (recorded in `launchChangedFiles`).
- On success the job is flipped to `done` via `agentJobs.completeJobExternally(...)` with the section/file count in the summary, and the guide is autosaved under the job's launch-time context snapshot.

## Persistence semantics, summarized

| State | Where it lives | Lifetime |
|---|---|---|
| Guide content (live job) | `guideResults: Map<jobId, …>` in memory | Until server restart |
| Reviewed checkboxes (live job) | `guideReviewed: Map<jobId, …>` in memory + write-through to the autosaved file | Per session, then durable |
| Failed payload | `failedPayloads: Map<jobId, …>` in memory | Per session |
| Launch-time changed-files | `launchChangedFiles: Map<jobId, …>` in memory | Per session, outlives the job (used by manual repair) |
| Saved guide (post-completion) | `${PLANNOTATOR_DATA_DIR}/guides/{repo-key}/{id}.json` | Durable |
| Launch-time context (PR url, head sha, label) | `job.guideContext` on the job | Used at save time to label the envelope correctly |

The `moved` flag on a saved guide compares the stored `headSha` against `currentHeadSha()`. PR mode uses `prMetadata.headSha`; local mode uses `git rev-parse HEAD`.

## Out of v1 scope (per ADR-006 / spec)

- Multiple concurrent guides UI.
- Guide sharing (URL or otherwise).
- Marker engines for guide generation are not in scope (Pi, Cursor, OpenCode only through the marker contract; Claude/Codex are the primary targets).
- Hunk-level slicing — refs are file-level, not line-precise.
- Sidebar annotation click on a collapsed section's diff (the diff is unmounted; you expand the section first).
- `lineStart`/`lineEnd` scroll targeting inside guide viewers.
- Search inside the guide view.

## File map

| Concern | File |
|---|---|
| ADR | `adr/decisions/006-guided-review-first-class-feature-20260702-192821.md` |
| Spec | `adr/specs/guided-review-20260702-195351.md` |
| Recap | `adr/recap-guided-review-20260702-220407.md` |
| Shared types | `packages/shared/guide.ts` |
| Disk persistence | `packages/shared/guide-store.ts` |
| Server module | `packages/server/guide/guide-review.ts` |
| Server tests | `packages/server/guide/guide-review.test.ts`, `packages/server/guide-persistence.test.ts` |
| Provider registration | `packages/server/agent-jobs.ts:68-74` |
| Server route wiring | `packages/server/review.ts:220-260, 923-986, 1288-1330, 1430-1524` |
| Pi mirror | `apps/pi-extension/server/serverReview.ts` (around lines 773, 1345, 1409-1487) |
| Takeover + badge + auto-open | `packages/review-editor/App.tsx:248-262, 1034-1063, 2224-2235, 2276, 2788-2808, 3220, 3274, 3294, 3369-3385` |
| Screen | `packages/review-editor/components/guide/GuideScreen.tsx` |
| Launch / failure / previous guides | `packages/review-editor/components/guide/GuideEmptyState.tsx` |
| Generating | `packages/review-editor/components/guide/GuideGenerating.tsx` |
| View | `packages/review-editor/components/guide/GuideView.tsx` |
| Section card | `packages/review-editor/components/guide/GuideSectionCard.tsx` |
| Diff section | `packages/review-editor/components/guide/GuideDiffSection.tsx` |
| Hooks | `packages/review-editor/hooks/guide/useGuideData.ts`, `useGuideLaunch.ts` |
| Demo | `packages/review-editor/demoGuide.ts` |
| Shortcut binding | `packages/ui/shortcuts/code-review/tourDialog.shortcuts.ts` (also covers guide) |
| Reused agent settings UI | `packages/ui/components/AgentControls.tsx` |
| Shared prose renderer | `packages/review-editor/utils/renderMarkdownProse.tsx` |

## Known gaps / open questions

- The "first-class" framing in the ADR is correct in scope but not in mechanics: the entire user-visible feature set is composition of existing diff-rendering, annotation, agent-jobs, and launch-settings infrastructure, with the guide's own contribution being the data model, the prompt, the fail-closed validator, the persistence layer, and the takeover UI. Whether Patchdesk should follow the same composition pattern vs. introducing a parallel subsystem is a separate design question.
- `GuideDiffSection` uses fixed 150-620px boxes with internal scroll because `DiffViewer` is `h-full` internally and won't grow to fit content. The spec acknowledges this as accepted-for-v1 and defers sizing.
- Auto-open fires on SSE snapshot replay after reload (tour-parity behavior, intentionally not special-cased).
- The repair path is prompt-based: it asks the model to fix its own broken JSON. There is no local syntax-only repair launched via the same engine, even though `repairGuideJsonText` already exists and could in principle be a server-side fallback. The current design treats the model as a second pass; the local repair is a separate user-driven path through the textarea.
- Pi mirror exists and is maintained, but this research only verified the Bun-server path.
