---
created_at: 2026-07-26
status: draft
scope: Codiff's narrative walkthrough (data model, agent generation, normalization, renderer, commit composition, sharing, headless CLI integration)
canonical_packet: narrative-walkthrough
repo: github.com/nkzw-tech/codiff
sources:
  - README.md (Walkthroughs section, lines 171-247)
  - core/walkthrough/narrative-walkthrough.schema.json
  - core/types.ts (WalkthroughStop, WalkthroughChapter, NarrativeWalkthrough, WalkthroughContext, WalkthroughProgressEvent, SharedWalkthroughSnapshot)
  - core/lib/narrative-walkthrough.ts
  - core/lib/narrative-walkthrough-diff.cjs
  - core/SharedWalkthroughApp.tsx (ReviewSurface, integration of walkthrough navigation)
  - core/app/components/walkthrough/NarrativeWalkthroughView.tsx
  - core/app/components/walkthrough/NarrativeSidebar.tsx
  - core/app/components/walkthrough/useNarrativeNavigation.ts
  - core/app/components/walkthrough/WalkthroughDiffSurface.tsx
  - core/app/components/walkthrough/WalkthroughProgress.tsx
  - core/app/components/walkthrough/parts.tsx
  - core/app/components/walkthrough/CommitView.tsx
  - electron/narrative-walkthrough-schema.cjs
  - electron/narrative-walkthrough.cjs
  - electron/walkthrough-store.cjs
  - electron/walkthrough-context.cjs
  - electron/walkthrough-progress.cjs
  - electron/walkthrough-diagnosis.cjs
  - electron/walkthrough-commit.cjs
  - electron/walkthrough-sharing.cjs
  - electron/main.cjs (codiff:getNarrativeWalkthrough handler, walkthroughProgressGenerations map)
---

# Codiff Narrative Walkthrough — research

## Question

What is Codiff's narrative walkthrough, how is it wired end-to-end (CLI → agent → schema → normalization → renderer → commit), and how does it differ from Plannotator's guided review?

## What it is

A **commit-walkthrough reading mode for an Electron desktop app.** Running `codiff -w` (or selecting Walkthrough in the sidebar) calls a local agent CLI (Codex, Claude Code, OpenCode, or Pi) which returns a JSON walkthrough that organizes the current diff into chapters and stops. The renderer renders it as a hybrid view: a left sidebar with a table of contents, a right diff surface that scrolls through stops in sequence, and a commit composer at the end for working-tree sources. The reviewer can navigate stop-by-stop, visit the trailing "Support" section, then write a subject + body and commit only the files they select.

Codiff's equivalent of Plannotator's "guided review" is the `narrative walkthrough` (or just "walkthrough" in user-facing copy). The two features share a North Star — chapter the diff by importance so a reviewer can read a large change in one sitting — but take meaningfully different shapes:

- Plannotator's guide is a **screen takeover** (file tree + dock hidden, right sidebar intact), with chapters containing DiffViewer instances that can be annotated inline, and persistence across server restarts.
- Codiff's walkthrough is a **hybrid view-mode** that replaces the diff surface but keeps the file tree as a separate sidebar tab. Diffs render in the same `ReviewCodeView` used by tree and comments modes, so inline review comments and PR review comments work uniformly.

## User-facing flow

1. **Trigger.**
   - `codiff -w` (CLI flag, also `codiff -w a1b2c3d` for a specific commit).
   - `codiff --share` to upload a walkthrough without opening Codiff.
   - Sidebar tab `Walkthrough` in the desktop app.
   - Agent integration: a `$codiff` (Codex) or `/codiff` (OpenCode) slash command in the user's agent that asks Codiff for the current authoring guide, writes a walkthrough JSON to a temp file, and opens Codiff on it with `--walkthrough-file`.
2. **Generation.** A local agent CLI is spawned (`spawned from electron/main.cjs` → `readNarrativeWalkthrough` in `narrative-walkthrough.cjs`). The agent gets the repository digest and the conversation context (a `WalkthroughContext` summarizing the user's agent session: objective, decisions, risks, implementation summary, file-level roles, last 18 messages) plus any `settings.walkthroughPrompt` custom instructions.
3. **Progress.** While the agent runs, the renderer shows a `WalkthroughProgress` component cycling through labels like "Building walkthrough…", "Composing walkthrough…", "Writing walkthrough…" with an elapsed-time indicator (visible after 3 seconds). Phases are `'agent-generation'` and `'response-received'`, reported via an IPC channel (`codiff:walkthroughProgress`) with a per-WebContents generation counter so a stale in-flight request can't overwrite a newer one.
4. **Normalization.** The raw response is run through `normalizeNarrativeWalkthrough` which validates against `narrativeWalkthroughSchema` (and a stricter `narrativeWalkthroughResponseSchema` for agent calls, derived via `strictResponseSchema`). This is the trust boundary: authoring agents constrain output to the schema; the renderer trusts only the normalized result.
5. **Render.** The renderer constructs a `WalkthroughView` via `buildWalkthroughView(walkthrough)` in `core/lib/narrative-walkthrough.ts`. The view adds:
   - a globally indexed `sequence` of stops (one list across all chapters, so navigation can address stops by index)
   - `support` groups, preserved in input order
   - `supportByReason`, grouped by `reason` string for the renderer's collapsible support sections
6. **Reading.** `NarrativeWalkthroughView` is the main hybrid view. It renders each stop's `prose` as `Narration` (rendered via `renderInlineMarkdown`), then for each hunk group resolves the hunk aliases to live diff sections, calls `focusChangedFileForHunks` to construct a one-section `ChangedFile` view, and feeds that to `WalkthroughDiffSurface` → `ReviewCodeView` with one or more `ReviewDiffBlock`s per stop.
7. **Support section.** After the last stop, a "Support" section lists all `WalkthroughSupportGroup`s. Each group carries a `reason` (e.g. "Generated files", "Other changes", or an agent-supplied reason). The renderer's `SupportingFilesStop` group-row collates them.
8. **Commit composer (working tree only).** For `source.type === 'working-tree'`, the renderer shows a `CommitView` at the end with the agent-drafted `commit.title` / `commit.body` (editable), a checklist of every changed file the walkthrough covered, and a `git commit` button. The path to the actual commit goes through `walkthrough-commit.cjs` which spawns `git commit` in a PTY (via `node-pty`) and streams pre-commit hook output to a ghostty-web terminal in the renderer.
9. **Sharing.** Walkthroughs can be uploaded to a Cloudflare R2 / D1 backend at `https://codiff.dev` (or `codiff.cloudflare.dev` for Cloudflare-internal users), producing a read-only `SharedWalkthroughSnapshot` that the share-page renderer (`SharedWalkthroughApp.tsx`) loads. Sharing can also be done headlessly via `codiff --share`.

## Data model

Schema lives in `core/walkthrough/narrative-walkthrough.schema.json` (kept in sync with `electron/narrative-walkthrough-schema.cjs`; `electron/__tests__/narrative-walkthrough.test.ts` enforces equality):

```json
{
  "version": 4,
  "kind": "narrative",
  "title": "...",
  "focus": "1-2 sentence framing",
  "commit": { "title": "...", "body": "..." },   // working tree only
  "chapters": [
    {
      "id": "c1",
      "title": "UI",
      "icon": "bug | wrench | path | flask | beaker | doc | gear",
      "blurb": "...",
      "stops": [
        {
          "id": "s1",
          "title": "Prevent duplicate payments",
          "hunkIds": ["h3", "h4"],
          "importance": "critical | normal | context",
          "prose": "markdown prose",
          "changeType": "fix | feature | refactor | test | generated | lockfile | snapshot | i18n | docs",
          "summary": "...",
          "commitNote": "...",
          "notes": [{ "hunkId": "h3", "body": "..." }]
        }
      ]
    }
  ],
  "support": [
    {
      "id": "sup-1",
      "hunkIds": ["h7", "h8"],
      "reason": "Generated files | Lockfile | Snapshot | Mechanical | <custom>",
      "note": "...",
      "title": "...",
      "summary": "...",
      "changeType": "..."
    }
  ]
}
```

`core/types.ts` mirrors the same shape on the TypeScript side:

- `WalkthroughIcon = 'bug' | 'wrench' | 'path' | 'flask' | 'beaker' | 'doc' | 'gear'`
- `WalkthroughChangeType = 'fix' | 'feature' | 'refactor' | 'test' | 'generated' | 'lockfile' | 'snapshot' | 'i18n' | 'docs'`
- `WalkthroughHunkGroup` is the shared shape: `{ id, hunkIds, hunks, added, deleted, changeType?, summary?, commitNote?, notes? }`
- `WalkthroughStop = WalkthroughHunkGroup & { importance, prose }`
- `WalkthroughSupportGroup = WalkthroughHunkGroup & { reason, note? }`
- `WalkthroughChapter = { id, title, icon, blurb, stops }`
- `NarrativeWalkthrough` adds: `{ agent: 'codex' | 'claude' | 'opencode' | 'pi', version: 4, kind: 'narrative', title, focus, chapters, support, repo, source, generatedAt, commit?, context?, meta }`

Notes on the schema:

- **`hunkIds` are compact request-local aliases** like `h1`, `h2` (per buildPromptInput → `nextHunkAlias`). Codiff never asks the model to invent stable ids; it returns the aliases verbatim and maps them back to live diff hunk ids via the `hunkIdByAlias` map captured at prompt build time.
- **Chapter titles are short**: max 16 chars, 1-2 words (e.g. "UI", "CLI", "Tests", "Docs", "Runtime", "Cleanup"). The renderer relies on this for a compact top bar.
- **Stop titles are never filenames** — must be a 2-6 word semantic name. The renderer has a `walkthroughItemTitleFallback` that recovers from a missing/garbled title by reading the first sentence of `summary` or `prose`, stripping markdown formatting, and truncating to 80 chars.
- **`support` is auto-derived**: anything the agent did not place in a chapter is bucketed into a synthetic support group by `addUnreferencedSupport` (path-keyed, max 14 hunks per group, reason inferred from `generatedHunkIds`).
- **`commit` is agent-drafted** for working trees only; for past commits, branches, and PRs it is stripped during normalization.
- **`notes` are per-hunk header notes** rendered above the focused diff block in the diff surface (a smaller unit than the stop's `prose`).

## Server (Electron main process) — `electron/narrative-walkthrough.cjs`

The single file that owns generation, normalization, and parsing. 961 lines, but it is one cohesive trust boundary.

### Generation prompt

`buildNarrativeWalkthroughPrompt(state, context, agentLabel, customPrompt, previousWalkthrough)` returns:

- **System framing**: "You are authoring Codiff's narrative walkthrough JSON." Hard rule: "Return JSON only. Do not inspect the repository or run shell commands; use only the optional conversation context and repository digest below."
- **Source-description caveat**: if `source.description` is present (a PR/MR body), treat it as author-written intent, not proof of behavior. The digest is the source of truth for what changed.
- **Sizing guidance** (`buildWalkthroughSizingGuidance`): target stop count, target chapter count, and chapter-instruction format derived from `fileCount` and `hunkCount`. For example:
  - 1-2 files, ≤4 hunks: 1-2 stops
  - 1-2 files: 1 chapter
  - >16 files: 6-9 stops
- **Coverage contract**: agent is told to put the highest-leverage review path in `chapters[]` and let Codiff place everything else in support. Output must be: hunk aliases verbatim, stops in display order, one review idea per stop, multiple `hunkIds` when hunks implement the same idea.
- **Grouping contract**: chapter titles ≤16 chars (1-2 short words), stop titles are 2-6 word semantic names (never filenames), generated-like files are never split, secondary hunks are left for support.
- **Custom prompt** (`buildCustomPromptInput`): appends user-supplied `settings.walkthroughPrompt` as "use to customize language, tone, and detail; if they conflict with the schema or digest, keep Codiff's constraints".
- **Previous walkthrough** (`buildPreviousWalkthroughInput`): when regenerating, the previous walkthrough is summarized (chapters + commit, no hunk ids or anchors) and the agent is told to re-author for the current digest, keeping accurate stops, revising changed explanations, removing dead ones, and re-anchoring every stop to the current aliases.
- **Repository change digest** (`buildPromptInput`): the structured digest itself, JSON-encoded.

### Digest shape (`buildPromptInput`)

Each file is a list of sections, each section is a list of hunk objects keyed by alias:

```jsonc
{
  "branch": "main",
  "root": "/abs/path",
  "source": { "type": "pull-request", "url": "...", "title": "...", "description": "..." /* truncated to MAX_PROSE_CHARS */ },
  "files": [
    {
      "path": "src/App.tsx",
      "oldPath": null,
      "status": "modified",
      "generated": false,                       // omitted when false
      "generatedReason": "Generated-like file; ...",
      "sections": [
        {
          "id": "...",
          "kind": "...",
          "binary": false,
          "loadState": "ready",
          "summary": "...",
          "patchExcerpt": "diff text (truncated per section budget)",
          "hunks": [
            { "id": "h1", "kind": "patch", "added": 4, "deleted": 1, "header": "@@ -10,6 +10,9 @@", "oldLines": "10-15", "newLines": "10-18" }
            // OR
            { "id": "h2", "kind": "synthetic", "added": 0, "deleted": 0, "summary": "..." }
          ]
        }
      ]
    }
  ]
}
```

Patch budgets: per-section `MAX_SECTION_PATCH_CHARS = 2_500` (700 for large diffs >32 files), per-digest `MAX_TOTAL_PATCH_CHARS = 60_000` (35_000 for large diffs). `getPromptPatchBudgets` selects which pair to use.

### Response schema (`strictResponseSchema`)

OpenAI structured outputs require every object key listed in `required`. `strictResponseSchema` is a recursive transform that derives a stricter `narrativeWalkthroughResponseSchema` from the more ergonomic `narrativeWalkthroughSchema`: every object key becomes required, optional fields become nullable (`type: ['string', 'null']` or `anyOf: [{ const }, { type: 'null' }]`). This is the only schema the agent is constrained to output against; the renderer never sees the strict schema, only the normalized result.

### Parsing and normalization

`readNarrativeWalkthrough` is the entry point:

```js
const response = await agent.run(state.root, prompt, narrativeWalkthroughResponseSchema, 'walkthrough.json', timeoutMessage, { timeoutMs, onProgress });
agentOptions?.onProgress?.('response-received');
const parsed = parseJSONMessage(response);                  // shared with all agent paths
const walkthrough = normalizeNarrativeWalkthrough(parsed, state.files, { agent, branch, generatedAt, root, source }, hunkIdByAlias);
```

`parseJSONMessage` is the shared agent helper. `normalizeNarrativeWalkthrough` does the heavy lifting:

1. Reject legacy v3 walkthroughs (anchors[] instead of hunkIds[]). The check is structural, not a version pin: `isLegacyV3Walkthrough(input)` looks for `version: 3`, OR `chapters[].stops[].anchors` arrays, OR `support[].files` arrays.
2. `indexFiles(files, hunkIdByAlias)` builds `{ hunkById, generatedHunkIds }`. Aliases are also inserted into the map so the agent's `h1` resolves to the underlying hunk.
3. `normalizeChapters(input, index, coveredHunkIds)`:
   - Walks each chapter's stops.
   - `normalizeHunkGroup` per stop: dedupes `hunkIds`, validates that each resolves via `resolveHunks` (returns null if any hunk id doesn't exist in the index), sums line counts via `sumHunkLineCounts`, optionally sanitizes `title`, `summary`, `changeType`, `commitNote`, and per-hunk `notes`.
   - Skips stop groups that overlap `coveredHunkIds` (a hunk already used in a prior stop) or duplicate a prior `hunkGroupKey`.
   - Coerces `prose` via `cleanRich` (trim, hard cap at 4_000 chars with `…`).
   - Coerces `importance` via `normalizeEnum(stop?.importance, IMPORTANCES, 'normal')` — default 'normal' on unknown values.
   - Tracks global `stopCount`; breaks at `MAX_WALKTHROUGH_STOPS = 14`.
4. Reject if zero chapters or zero stops: `throw new Error('Narrative walkthrough has no chapters with resolvable stops.')`.
5. `normalizeAuthoredSupport`: walk the input's `support[]` array. Each group is normalized like a stop (sans importance/prose). Skips groups whose hunks overlap already-covered hunk ids; tags `reason` as 'Generated files' if every hunk is generated, else `cleanText(item?.reason, 'Other changes')`.
6. `addUnreferencedSupport`: anything in `index.hunkById` that wasn't placed is bucketed by file path (groups of up to `MAX_HUNKS_PER_WALKTHROUGH_GROUP = 14`), each synthetic group carries a `reason` of 'Generated files' (when applicable) or 'Other changes' and a `title` of the file path.
7. Compose the final envelope: `agent`, `kind: 'narrative'`, `version: 4`, `title`, `focus`, `chapters`, `support`, `repo: { branch, root }`, `source`, `generatedAt`, `meta: '<N> stops · <M> chapters'`.
8. **Working-tree commit composer** (`result.source.type === 'working-tree'`): synthesize a `commit` block from the input's `commit.title` / `commit.body`. If no title but a body, try to promote the first non-blank line if it satisfies `isCommitTitleLine` (≤72 chars, no terminal punctuation). Then `stripLeadingCommitTitle(body, title)` removes the title from the body if it was duplicated.

Coverage contract enforcement is the key invariant: every hunk in `index.hunkById` ends up either in a chapter stop, in `support`, or in a synthetic unreferenced-support bucket. Nothing is silently dropped.

### Cache and keying (`walkthrough-store.cjs`)

- `~/.codiff/walkthroughs/{sha256(cacheKey)}.json` with `MAX_STORED_WALKTHROUGH_BYTES = 8 * 1024 * 1024`.
- The cache key (`getNarrativeWalkthroughCacheKey`) is a SHA-256 over: `{ agent, diff: [{ path, oldPath, status, fingerprint, sections: [{ id, kind, hunkIds }] }], model, prompt, responseSchema, version: 1 }`.
- **Previous walkthrough is intentionally excluded** from the cache key, so forced regeneration replaces the cached result for the current diff rather than creating a second cache lineage.
- Reads use `isNarrativeWalkthrough` (a structural check, not a schema validator) to refuse corrupt or out-of-shape files. Writes are atomic: temp + rename with `EEXIST/EPERM` fallback to a `rmSync` + rename.

### IPC handler

`ipcMain.handle('codiff:getNarrativeWalkthrough', ...)` in `main.cjs:1436`:

- Bumps `walkthroughProgressGenerations` for this `event.sender.id` so a stale in-flight request cannot overwrite a fresh one.
- Resolves `agent = resolveWindowAgent(event.sender.id)` (per-window agent selection; defaults to the first installed CLI in order: Codex, Claude Code, OpenCode, Pi).
- `--walkthrough-file` path: read JSON from disk, run `normalizeNarrativeWalkthrough` against the live diff, fall back to `diagnoseWalkthroughMismatch` for a specific reason when validation fails on a working-tree walkthrough with no current diff.
- Otherwise: merge `launchOptions.walkthroughContext` (CLI-supplied) with the agent's session context (`agent.readSessionContext(...)`); pick the model with `resolveNarrativeWalkthroughModel`; check the cache; otherwise call `readNarrativeWalkthrough` and persist the result.
- Returns either `{ status: 'ready', walkthrough }` or `{ status: 'unavailable', reason, code? }`.

## Renderer

### View-model layer — `core/lib/narrative-walkthrough.ts`

Pure functions that take a `NarrativeWalkthrough` + `ChangedFile[]` and produce render-friendly data:

- `buildWalkthroughView(walkthrough)`: returns `null` if no chapters or no stops; otherwise maps stops to `WalkthroughStopView[]` (each with a global `index` and `chapterId`), groups support by `reason` (`groupSupportByReason`), returns `{ chapters, sequence, support, supportByReason }`.
- `resolveWalkthroughHunkFile(hunk, files)`: looks up `file = files.find(f => f.path === hunk.path)` and `section = file.sections.find(s => s.id === hunk.anchor.sectionId)`. Returns `null` if either is missing — this is how stale refs degrade gracefully.
- `resolveWalkthroughHunkRuns(item, files)`: coalesces adjacent hunks in the same file section into one `WalkthroughHunkRun` (a run is a contiguous slice of hunks from the same section). This is what the renderer shows as one diff block.
- `focusChangedFileForHunks(file, section, hunks)`: returns a `ChangedFile` view whose `sections` array is exactly the hunks the walkthrough wants rendered, in order. The hunk-filtered patch comes from `filterPatchToHunkIds` (in `narrative-walkthrough-diff.cjs`). For synthetic hunks, binary sections, or sections that aren't `loadState: 'ready'`, the function returns the section as-is (the diff view handles synthetic hunks differently).
- `getUncoveredWalkthroughFiles(files, view, showWhitespace)`: returns `ChangedFile[]` for sections not covered by the walkthrough, with hunks filtered to only the uncovered ones. Each uncovered file gets a distinct fingerprint (`{fileFingerprint}:walkthrough-uncovered:{sectionId}:{hunkIds},…`).
- `getWalkthroughRunNote(item, run)`: collects any `notes` whose `hunkId` is in the run, joins them. This is the per-diff-block header note.
- `buildCommitModel(walkthroughView, files)`: composes the commit checklist. The default `commitSelected` set is "every file the walkthrough covered" (a derived `commitPaths` set).
- `isWalkthroughCommittable(walkthrough)`: `walkthrough.source.type === 'working-tree'`.
- `walkthroughItemTitleFallback(item)`: `item.title?.trim() || readableWalkthroughTitle(item.summary) || readableWalkthroughTitle(item.prose) || walkthroughFileName(item.hunks[0]?.path ?? item.id)` — the last-resort title is the file basename.

### Navigation state — `useNarrativeNavigation.ts`

Owned by `App.tsx`, passed to both `NarrativeSidebar` and `NarrativeWalkthroughView` (single source of truth for the rendered mode + index).

State:

- `mode: 'stop' | 'support' | 'commit'`
- `index: number` (index into `walkthroughView.sequence`)
- `scrollTarget: { index, nonce }` — `nonce` is bumped on every `goStop` so the consumer can distinguish "the user clicked" from "the index changed for some other reason"
- `supportScrollRequest: number` — bumped on `openSupport`
- `supportVisited: boolean`
- `visited: Set<string>` — stop ids the user has opened
- `commitSelected: Set<string>` — file paths checked in the commit composer
- `commitSubject`, `commitBody` — the editable commit draft
- `commitSubjectDirtyRef`, `commitBodyDirtyRef` — track whether the user has touched the fields so a walkthrough refresh doesn't clobber their edits

Two pending scroll locks: `pendingStopScrollRef` and `pendingSupportScrollRef`. Both are remembered against the `walkthrough` instance they were set for, so a walkthrough refresh implicitly invalidates them (the `walkthrough` reference changes). This is how the navigation state machine prevents a stale lock from clobbering a fresh navigation.

`goStop(target)` clamps to `[0, sequence.length - 1]`, sets `mode = 'stop'`, `index = target`, records the stop as visited, sets `pendingStopScrollRef`, bumps the scroll target's nonce, and clears `pendingSupportScrollRef`. `goNext` / `goPrev` are `goStop(index ± 1)`.

`syncIndexFromScroll(target)`: called by the consumer when scroll position changes; clamps, then respects any pending lock. A pending stop lock at a different index is silently dropped (the consumer is scrolling to something else). A pending stop lock at the same index clears the lock and accepts the scroll. A pending support lock for the current walkthrough short-circuits (don't change mode away from support). When no locks match, the consumer's index becomes authoritative.

`openSupport`: `leaveStopMode()`, set `index = sequence.length - 1` (so the user lands on the last stop, not the first), `mode = 'support'`, `pendingSupportScrollRef = { walkthrough }`, bump `supportScrollRequest`, `supportVisited = true`.

Reset behavior on a fresh walkthrough: `seededFor !== walkthrough` triggers a render-time state reset (`setSeededFor(walkthrough); setMode('stop'); setIndex(0); …`). Exception: if the user is already on the commit screen, do not yank them back to the first stop — that would also discard the visible commit error. The comment on this branch is one of the clearer ones in the codebase.

### Main view — `NarrativeWalkthroughView.tsx`

- For each stop, `getFocusedRunDiffs` resolves the hunk group to one or more `FocusedRunDiff` records (file + section + reviewIdentity). Each run coalesces adjacent same-section hunks.
- `createWalkthroughBlocks(files, walkthroughView, currentIndex)` returns `{ blocks, firstBlockIdByStop, stopIndexByBlockId }`. Each block is `{ id, header, headerSelected }`. Blocks for a stop are emitted in authored order; if the file can't be resolved, a "missing" block is emitted instead (so the prose still appears in the document).
- The view is rendered as one continuously scrolling document: stops are stacked, support section follows. The diff surface (`WalkthroughDiffSurface`) receives the blocks and the scroll target. Active-block tracking via `onActiveBlockChange` keeps the sidebar's "current stop" highlight in sync as the user scrolls.
- Keyboard nav: `j` / `k` to advance/retreat, `Ctrl+Down` / `Ctrl+Up` for the same. Nav is gated on no modifiers (j/k) or ctrl-only (arrow keys) so the same keys can type in form fields.
- "Visit" state in the sidebar: a visited stop gets a small ✓; the currently-active stop gets a pulsing dot.

### Sidebar — `NarrativeSidebar.tsx`

- `Review focus` panel at the top: `walkthrough.focus` rendered via `renderInlineMarkdown`.
- Per-chapter section: chapter icon (from `WalkthroughIcon`), title, then per-stop `TocStop` rows. Each stop shows: position number, title, and a file list (`formatWalkthroughFileLineRows(stop.hunks)`).
- `SupportingFilesStop` at the bottom: collates authored support + `getUncoveredWalkthroughFileLineItems(files, walkthroughView, showWhitespace)` so anything the walkthrough missed is still shown. Renders the count but a single "Support" click target.
- Commit composer preview (if `allowCommit && isWalkthroughCommittable(walkthrough)`): shows the file count and current selection.

### Diff surface — `WalkthroughDiffSurface.tsx`

A thin wrapper around `ReviewCodeView` (the same component the tree and comments modes use), with:

- `selectedPath: null` — selection is by stop, not by file
- `commitMetadata: null` — the commit composer's metadata lives in `CommitView`, not in the diff header
- `forceExpandedPaths: emptyPaths` — the walkthrough dictates which sections expand
- `bottomInset: 96` — reserves room for the next-stop / nav buttons
- `showSourceDescription: true` — for PRs, the PR description renders at the top
- `onSelectPathFromScroll: ignorePathScroll` — the walkthrough controls selection; scroll-induced file selection is suppressed
- `walkthroughNotes: emptyWalkthroughNotes` — per-run notes are passed as `ReviewDiffBlock.note` instead, not as the top-level walkthroughNotes map

`blocks` are `ReviewDiffBlock[]`, which is what the diff surface understands.

### Progress + commit — `WalkthroughProgress.tsx`, `CommitView.tsx`

- `WalkthroughProgress` cycles through `walkthroughResponseLabels` and shows a timer (visible only after 3s) for the current phase.
- `CommitView` uses `ghostty-web` to render live pre-commit hook output from `node-pty`'s PTY. `walkthrough-commit.cjs` ensures the macOS `spawn-helper` is executable (pnpm drops the bit), spawns `git -C <repo> commit ...` with `cols: 80, rows: 24` so hook output wraps where the terminal does, and forwards `onData` chunks to a subscriber. The renderer registers a `CommitOutputSubscriber` and feeds the chunks into the xterm-compatible terminal.

## Trust boundary and validation summary

- **Agent output** is constrained to `narrativeWalkthroughResponseSchema` (a strict response-format schema derived from the public schema). This catches most shape issues at the agent boundary.
- **`normalizeNarrativeWalkthrough`** is the renderer trust boundary. It re-validates hunk ids against the live diff (every agent-supplied hunk must resolve; otherwise the group is dropped), drops support groups that overlap already-covered hunks, dedupes, enforces max sizes (`MAX_WALKTHROUGH_CHAPTERS = 6`, `MAX_WALKTHROUGH_STOPS = 14`, `MAX_HUNKS_PER_WALKTHROUGH_GROUP = 14`), coerces enums (`importance`, `icon`, `changeType`) with safe defaults, and synthesizes `support` for any unreferenced hunks. Comment in the schema file: "Authoring agents constrain output to it; the renderer trusts only the normalized result, not the raw schema-valid input."
- **Legacy v3 detection** in `isLegacyV3Walkthrough` is structural: any input with `version: 3` OR `chapters[].stops[].anchors` OR `support[].files` is rejected with a specific error message ("Regenerate it with the v4 hunkIds[] schema for this diff").
- **`--walkthrough-file` path** uses `diagnoseWalkthroughMismatch` when the live diff has no files: it `git log`s the most recent commit touching any of the walkthrough's anchored paths, parses the subject via `%x1f` (so arbitrary characters parse safely), and returns a specific reason ("changes were committed since the walkthrough was authored", "stashed/reverted", or "uncommitted files that were discarded").

## Sharing — `electron/walkthrough-sharing.cjs`, `electron/headless-walkthrough-share.cjs`

- Targets: `https://codiff.cloudflare.dev` (Cloudflare email-authenticated, internal), or `https://codiff.dev` (public, unauthenticated). `forcePublic` flips internal users to public.
- `SharedWalkthroughSnapshot` is a versioned envelope (`version: 1`) containing the walkthrough + `files` + `repository` + `exportedAt` + optional `branch` + optional `reviewComments` / `codeQualityFindings` / existing `mergeRequestComments` / `pullRequestReviewComments`.
- `SharedWalkthroughApp.tsx` is the read-only renderer used by the share page. Review comments are reconstructed from `PullRequestExistingReviewComment[]` via `getReviewCommentsFromState`. The `interactive` callbacks (`onGenerateWalkthrough`, `onSubmitComment`, etc.) are all no-op on the shared view; the commit composer is replaced with a `disabledCommit` stub returning `'Shared walkthroughs are read-only.'`

## Headless integration

- `codiff -w` and `codiff --share` are CLI flags. The installer places `codiff` on `PATH` (after running `Codiff > Install Terminal Helper`).
- `$codiff` (Codex) and `/codiff` (OpenCode) are agent slash commands installed via `View > Install Skill`. The skill is a thin shim: it calls `codiff --walkthrough-guide` to get the current authoring guide, asks the agent to write a walkthrough JSON to a temp file, then calls `codiff --walkthrough-file <path> --walkthrough-context <context.json>` to open Codiff on it. The walkthrough sees the original conversation context without a lossy summary handoff (per README lines 240-244).

## File map

| Concern | File |
|---|---|
| README walkthrough section | `README.md:171-247` |
| Agent-mode schema | `core/walkthrough/narrative-walkthrough.schema.json` |
| Renderer schema mirror | `electron/narrative-walkthrough-schema.cjs` (with `strictResponseSchema` for response format) |
| Generation + normalization | `electron/narrative-walkthrough.cjs` |
| Disk cache | `electron/walkthrough-store.cjs` |
| Walkthrough context (agent session → JSON) | `electron/walkthrough-context.cjs` |
| Progress reporter | `electron/walkthrough-progress.cjs` |
| Failure diagnosis (--walkthrough-file mismatch) | `electron/walkthrough-diagnosis.cjs` |
| PTY-backed `git commit` | `electron/walkthrough-commit.cjs` |
| Share target resolution | `electron/walkthrough-sharing.cjs` |
| Headless share upload | `electron/headless-walkthrough-share.cjs` |
| IPC handler | `electron/main.cjs:1436-…` |
| Renderer view-model | `core/lib/narrative-walkthrough.ts` |
| Renderer diff helpers | `core/lib/narrative-walkthrough-diff.cjs`, `.js` |
| Types | `core/types.ts` (`WalkthroughStop`, `WalkthroughChapter`, `WalkthroughHunkGroup`, `WalkthroughSupportGroup`, `NarrativeWalkthrough`, `WalkthroughContext`, `SharedWalkthroughSnapshot`) |
| Shared read-only renderer | `core/SharedWalkthroughApp.tsx` |
| Main hybrid view | `core/app/components/walkthrough/NarrativeWalkthroughView.tsx` |
| Sidebar (TOC) | `core/app/components/walkthrough/NarrativeSidebar.tsx` |
| Navigation state machine | `core/app/components/walkthrough/useNarrativeNavigation.ts` |
| Diff surface wrapper | `core/app/components/walkthrough/WalkthroughDiffSurface.tsx` |
| Progress + commit | `core/app/components/walkthrough/WalkthroughProgress.tsx`, `CommitView.tsx` |
| Chapter icon, importance pill, narration | `core/app/components/walkthrough/parts.tsx` |

## Comparison with Plannotator's guided review

| | Plannotator guide | Codiff walkthrough |
|---|---|---|
| **App shape** | Local hook-driven browser UI; SPA hosted on a Bun server | Electron desktop app with renderer + main process |
| **Trigger** | Header "Guide" badge (Mod+Shift+G), auto-opens on completion | `codiff -w` CLI flag, sidebar tab, `$codiff` / `/codiff` agent slash command |
| **Screen model** | Screen takeover (file tree + center dock CSS-hidden) | Hybrid view: left sidebar TOC, right diff surface; tree and comments modes are siblings, not pre-hidden |
| **Diff rendering** | Owns its own `DiffViewer` instances per chapter | Reuses the same `ReviewCodeView` as tree and comments modes |
| **Annotation parity** | Hard constraint — guide annotations are the same `CodeAnnotation` state, same Send Feedback payload | Diffs are first-class `ReviewCodeView` blocks; inline review comments work uniformly because the rendering surface is shared |
| **Schema** | `CodeGuideOutput` (sections, file refs, unplacedFiles) | `NarrativeWalkthrough` (chapters → stops → hunk groups, plus `support`) |
| **Anchoring** | File paths (validated against changed files; first-placement-wins; unplaced for the rest) | Stable hunk aliases (e.g. `h1`, `h2`) mapped to live diff hunk ids at prompt build time; first-placement-wins; synthetic support for unreferenced hunks |
| **Hunk-level slicing** | File-level only | Hunk-level: agent can select specific hunks inside a section (`hunkIds: ['h3', 'h4']`) |
| **Header notes per hunk** | None | Yes: `notes: [{ hunkId, body }]` rendered as a header note above the focused diff block |
| **Importance / change type** | None — sections are ordered by `position` (`01 / 04`) | Per-stop `importance: critical | normal | context` (renders as a pill); per-file `changeType: fix | feature | refactor | …` for the commit composer |
| **Icons per chapter** | None | `WalkthroughIcon` enum (bug, wrench, path, flask, beaker, doc, gear) |
| **Persistence** | Durable: `${PLANNOTATOR_DATA_DIR}/guides/{repo-key}/{id}.json` with `saved` / `moved` flags | In-memory per process; on-disk cache `${HOME}/.codiff/walkthroughs/{sha256(cacheKey)}.json` keyed by agent + diff fingerprint + model + prompt; no "moved" detection — instead `diagnoseWalkthroughMismatch` for pre-authored walkthrough files |
| **Failure handling** | In-memory failed-payload capture + `POST /api/guide/:jobId/submit` (manual repair) + `repairOf` (low-effort repair job) + `repairGuideJsonText` mechanical fixup | In-memory; legacy v3 schema is rejected with a specific error; `--walkthrough-file` mismatch is diagnosed by `git log` against anchored paths and returns a specific reason |
| **Reviewed state** | Per-section `reviewed: boolean[]`, debounced PUT with keepalive flush | Per-stop "visited" set in renderer state only (no persistence); commit composer is the durable output |
| **Engines** | Claude (--json-schema), Codex (--output-schema), marker engines (Cursor/OpenCode/Pi/Copilot with nonce-tagged blocks) | Codex (default), Claude Code, OpenCode, Pi (all via local CLI; structured outputs via `agent.run(..., responseSchema, ...)`) |
| **Generation context** | `WalkthroughContext` not in Plannotator; plannotator uses conversation context from the agent session | `WalkthroughContext` (objective, decisions, risks, implementation summary, last 18 messages, file-level roles) merged from CLI-supplied + agent-session-derived |
| **Cache invalidation** | Launch-time snapshot of changed files (so mid-generation PR/diff switches don't invalidate a valid guide) | Cache key includes diff fingerprint + model + prompt; previous walkthrough is excluded so forced regeneration replaces (not duplicates) the cached result |
| **Sharing** | Plan sharing via short URLs (PrivateBin-style, server stores only ciphertext) | Walkthrough upload to Cloudflare R2 + D1; read-only `SharedWalkthroughSnapshot` for the share page |
| **Engine fallback / timeouts** | Timeout = agent's normal timeout | Sizing-based: `BASE_WALKTHROUGH_TIMEOUT_MS = 90_000` + per-file and per-hunk adders, capped at `MAX_WALKTHROUGH_TIMEOUT_MS = 300_000` (5 min). For Codex: large walkthroughs (≥100 hunks) with the default model swap to a `fallbackModel` |
| **Where the agent runs** | Hook spawns a CLI subprocess, response streams back over the local HTTP loopback | Electron main process spawns the CLI directly via the shared `agent` abstraction |

## Known gaps / open questions

- The renderer does not persist `visited` state; a reviewer who restarts Codiff loses their progress markers. Whether that matters is a product question — the commit composer is the durable output, the visited set is purely navigation state.
- The cache key includes the prompt body and the response schema. A change to either invalidates the entire cache for that `(agent, diff, model)` combination. For a daily-changing walkthrough that's probably fine; for hot iteration it can be wasteful.
- `walkthrough-commit.cjs` always commits the subset of files the reviewer selected. The current implementation does not appear to support a partial-stage-and-commit workflow (e.g. `git add -p`-style hunks) — the entire chosen file is staged, then committed.
- There is no equivalent of Plannotator's `moved` flag on saved walkthroughs. Instead, `--walkthrough-file` mismatch is detected at load time via `diagnoseWalkthroughMismatch`; live walkthroughs (generated in-session) cannot become "stale" because they are regenerated from the live digest on demand.
- The `WalkthroughContext` from `walkthrough-context.cjs` is bounded: max 16 list items per field, 120 file items, 18 messages (each up to 2,400 chars), text fields truncated to 1,800 chars. There is no streaming ingestion of the agent session — context is a snapshot at launch time. This is comparable to Plannotator's launch-time snapshot for changed files: both are snapshotted to keep the model prompt consistent with what the user sees.
- Renderer tests are minimal (mostly schema equality checks). The intricate navigation state machine in `useNarrativeNavigation.ts` does not have a dedicated test file. Manual reproduction and self-review are the primary correctness gates.
