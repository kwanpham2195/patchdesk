# Narrative walkthrough design

Feature packet: [sources](./00-sources.md) · [implementation plan](./implementation-plan.md)

## Purpose

Narrative walkthrough is a manually generated reading mode for a stored Patchdesk review snapshot. It organizes the patch into a small sequence of semantic, hunk-focused sections. The mode helps a reviewer understand the change in the order the work makes sense, then inspect and comment on the exact evidence.

Walkthrough does not run when a review run completes. A reviewer starts it explicitly from a prepared snapshot.

## User outcomes

- A reviewer can ask Patchdesk to explain a saved change as a short, ordered reading path.
- Each section gives context before showing the relevant diff hunks.
- A reviewer can mark the section reviewed without changing existing file viewed state.
- A reviewer can draft inline comments from a walkthrough diff. Those drafts are the same drafts available in Files mode.
- A reviewer can leave the walkthrough at any point and return to the existing file-first workbench.
- Every hunk in the stored patch remains visible. Content outside the main reading path appears in Support.

## Non-goals

- Automatically generating a walkthrough after a review run or when a snapshot opens.
- Replacing Files mode, its selection behavior, or its virtualized all-files review surface.
- Persisting a guide history, sharing walkthroughs, or accepting manual edits to model output.
- Creating a second review-comment store or changing GitHub write confirmation.
- Treating a walkthrough as current after its saved snapshot has changed.

## Reading experience

### Entry and generation

The review workbench exposes a **Generate walkthrough** action for a prepared, read-only snapshot. Selecting it opens a compact **Generate walkthrough** dialog before work starts. The dialog uses the active Pi model catalog, lets the reviewer choose a model and reasoning level (`Low`, `Medium`, or `High`), restores the last valid per-profile choice, and states that generation reads the saved snapshot without writing to GitHub. Patchdesk shows a dedicated generating state while the selected local model produces structured output.

Generation is scoped to the stored patch and its snapshot identity. A reviewer does not need to rerun analysis to create a walkthrough. If generation fails, or the result cannot be normalized against the stored patch, Patchdesk shows a concise failure state with **Retry generation**.

### Focused takeover

A successful walkthrough opens a focused screen takeover. The usual Files rail is hidden. The takeover contains a semantic navigation rail and a continuous central reading surface. A persistent **Back to files** action returns to the normal workbench.

Returning to Files restores its prior explicit selection, passive scroll-follow state, and diff controls. Walkthrough state never writes to `selectedPath`, `activePath`, or the tree selection. Files mode keeps its current interaction contract.

The rail contains:

- A one- or two-sentence review focus.
- Short chapter labels.
- Ordered section titles and current/complete state.
- A trailing Support entry.

The main surface renders, in order:

1. The walkthrough title and focus.
2. Each section's prose and the exact normalized hunk groups that support it.
3. Support content for every hunk not included in a primary section.

Sections use the current diff theme, split or unified preference, wrapping preference, context hydration, and inline draft controls. They do not introduce a different code viewer.

### Progress and comments

Each section has a **Reviewed** control. It records only walkthrough progress. It does not collapse, mark viewed, or otherwise change a file in Files mode.

File viewed state also remains independent. Marking a file viewed in Files mode never completes a walkthrough section.

Inline comment drafting is available in walkthrough diffs. A draft created there is immediately visible in the existing review draft flow and remains subject to the current explicit user confirmation before Patchdesk writes to GitHub.

## Walkthrough model

The renderer consumes only a normalized walkthrough. Raw model output is never rendered.

The model has this conceptual shape:

```ts
type Walkthrough = {
  readonly snapshotId: string;
  readonly title: string;
  readonly focus: string;
  readonly chapters: readonly WalkthroughChapter[];
  readonly support: readonly WalkthroughHunkGroup[];
};

type WalkthroughChapter = {
  readonly id: string;
  readonly title: string;
  readonly sections: readonly WalkthroughSection[];
};

type WalkthroughSection = {
  readonly id: string;
  readonly title: string;
  readonly prose: string;
  readonly hunkIds: readonly string[];
};

type WalkthroughHunkGroup = {
  readonly title: string;
  readonly hunkIds: readonly string[];
};
```

Hunk identifiers are stable only inside the patch parsed for this snapshot. The generator receives compact aliases rather than inventing paths, line numbers, or anchors. Normalization resolves aliases back to known parsed hunks before rendering.

The prompt asks for a small semantic sequence. It describes the core behavior first, follows consequences and tests where they belong, and keeps low-signal mechanical changes in Support. Section titles describe an idea, not a filename.

## Normalization and coverage

Normalization is the trust boundary between the local model and the renderer.

- Reject a result with no valid primary sections.
- Remove hunk references that do not resolve in the source snapshot.
- Keep the first occurrence of a hunk and remove later duplicates or overlaps deterministically.
- Apply fixed bounds to title length, prose length, chapter count, section count, and hunk count per section.
- Derive Support from every remaining hunk that the primary sections did not cover.
- Retain the normalized snapshot identity with the result.

This creates a coverage invariant: every parsed patch hunk belongs to exactly one primary section or one Support group. Patchdesk must not silently omit content because the model did not mention it.

If a snapshot refreshes or the stored patch changes, discard the in-memory walkthrough for that snapshot. The workbench can offer generation again for the new snapshot. It must not label old narrative output as an explanation of the new diff.

## Architecture

The feature follows Patchdesk's existing domain, service, adapter, and local-API boundaries.

### Domain

The domain owns walkthrough identifiers, bounded structured types, normalized hunk references, the coverage invariant, and section completion state. These types do not depend on React, the local API, or a model provider.

### Service

A walkthrough service accepts a prepared review snapshot and its stored patch. It builds the generator input, resolves returned aliases, normalizes the response, and returns either a snapshot-bound walkthrough or a failure. It does not mutate the snapshot or start a review run.

### Adapter and local API

Walkthrough generation runs as a new finite Flue workflow, separate from `workflow:review-pr`. It receives only the prepared snapshot identity, stored patch path, and bounded review context. Its output schema is the raw walkthrough shape, not review findings.

The main process invokes that workflow through the existing local runtime boundary. The renderer calls authenticated loopback endpoints to generate, load, and retry a walkthrough. The main process retains all process and filesystem access. This does not add a public Patchdesk review route to `src/app.ts`.

### Renderer

The renderer owns takeover visibility, selected walkthrough section, completed sections, and return-to-Files behavior. A walkthrough-specific navigation state controls the semantic rail. It does not reuse or mutate the Files-mode `selectedPath` or passive `activePath` state.

The hunk-focus adapter filters the immutable stored patch to each normalized file/hunk group, then reparses that bounded patch into a small Pierre block. Pierre's public React API is file/patch oriented; it cannot safely render a filtered `FileDiffMetadata.hunks` array. The adapter must never mutate Files-mode `ReviewDiffView` state or materialize its all-files stream. It reuses the current Pierre theme/options and derives inline-draft annotations from the existing review batch.

## States and recovery

The walkthrough region has these states:

- Not generated: explain the mode and offer Generate walkthrough.
- Generating: show progress without hiding snapshot identity.
- Ready: show the focused takeover.
- Invalid or failed: show the failure reason and Retry generation.
- Stale: explain that the snapshot changed and offer generation for the current snapshot.

V1 does not show raw model output or accept pasted repair JSON. The retry path asks the configured model to author a new result for the same stored patch.

## Verification

Unit and integration tests cover the model boundary:

- Valid aliases resolve to the intended hunk groups.
- Unknown, duplicate, and overlapping aliases are removed deterministically.
- Every input hunk appears exactly once after Support derivation.
- Empty or invalid results fail closed.
- Generation binds output to one snapshot and never starts automatically.

Renderer tests cover the interaction boundary:

- Generate, generating, ready, invalid, retry, and stale states.
- Focused takeover and explicit return to Files mode.
- Section Reviewed state remains separate from file viewed state.
- Inline drafts created in walkthrough diffs appear in the existing draft batch.
- Walkthrough navigation does not change Files-mode `selectedPath`, passive `activePath`, inspector state, or current diff preferences.

Browser tests cover keyboard section navigation, inline draft creation, Back to files, Support coverage, and both unified and split surfaces. The existing 1,000-file selection ceiling remains below 200 ms. Packaged-app verification uses the project-required isolated Electron tester workflow.

## References

- [Patchdesk narrative walkthrough research](./01-research-patchdesk.md)
- [Codiff narrative walkthrough research](./02-research-codiff.md)
- [Plannotator guided review research](./03-research-plannotator.md)
- [Pierre integration research](./04-research-pierre.md)
