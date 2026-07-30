# Review workbench journey Design implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved review-workbench journey as deterministic, browser-only Design scenarios before applying the product changes to the Electron renderer.

**Architecture:** Keep the Design app as a safe visual reference. Add Design-only workbench, recovery, and publish-confirmation surfaces under `src/design/`; they use renderer UI primitives but do not call the local API, GitHub, Electron, or the filesystem. Keep the 22 stable scenario IDs and make each changed path directly testable through `tests/browser/design.spec.ts`.

**Tech Stack:** TypeScript, React, Tailwind v4, shadcn/Base UI primitives, Playwright.

## Global constraints

- Edit only `src/design/`, `tests/browser/design.spec.ts`, and Design-specific fixtures when this plan is executed. Do not change production renderer, services, local API, preload, Electron, or GitHub-write behavior.
- The Design app remains browser-only and deterministic. No Design action may call GitHub, the filesystem, Electron preload, or a live model.
- Preserve the 22 permanent scenario IDs in `src/design/scenarios.ts`.
- Opening `review-prepared` lands in Files. The Design header uses `Snapshot · no GitHub writes`, compact check status, secondary walkthrough, and one primary `Run analysis` action.
- Recovery scenarios always expose `Back to inbox`; show `View snapshot` only when the fixture marks the stored snapshot readable.
- The walkthrough takeover is a reading surface. It has no batch editor, add-to-draft control, inline-comment action, or Publish action.
- Failed and stale walkthrough states render one lifecycle action. Stale content is not rendered as current content.
- Submit confirmation shows counts for inline comments, replies, and thread-state actions. Merge confirmation names each warning beside the acknowledgement checkbox.
- Keep existing user-owned dirty-worktree changes intact. Do not create or switch branches without explicit consent.

---

## File map

- Create: `src/design/design-review-journey-scenario.tsx` — prepared and completed workbench visual target, including local PR overview state and a safe diff-reading fixture.
- Create: `src/design/design-publish-confirmation-scenario.tsx` — Design-only submit and merge confirmation dialogs with concrete action and warning summaries.
- Modify: `src/design/design-app.tsx` — route the existing stable scenario IDs to Design-only target surfaces.
- Modify: `src/design/design-recovery.tsx` — render target recovery panels with safe exits and target labels.
- Modify: `src/design/design-walkthrough-scenario.tsx` — make walkthrough states strictly reading-only, remove duplicate actions, hide stale content, and make model overrides advanced-only.
- Modify: `src/design/scenarios.ts` — retain IDs while updating titles and descriptions to the approved vocabulary.
- Test: `tests/browser/design.spec.ts` — assert target behavior, visible action count, and deterministic interaction for each revised Design scenario.

## Task 1: Build the prepared and completed workbench targets

**Files:**

- Create: `src/design/design-review-journey-scenario.tsx`.
- Modify: `src/design/design-app.tsx`.
- Modify: `src/design/scenarios.ts`.
- Test: `tests/browser/design.spec.ts`.

**Interfaces:**

- `type DesignReviewJourneyVariant = "prepared" | "completed"`.
- `DesignReviewJourneyScenario({ variant }: { readonly variant: DesignReviewJourneyVariant }): React.JSX.Element`.
- `DesignPrOverview({ onClose }: { readonly onClose: () => void }): React.JSX.Element` renders the local check and refresh context.
- `DesignFilesSurface(): React.JSX.Element` renders the bounded Design-only file rail and stored diff.
- `data-testid="design-review-prepared"` and `data-testid="design-review-completed"` identify the two stable workbench targets.

- [ ] **Step 1: Write the failing prepared-workbench browser test.**

  Add a test that opens `?scenario=review-prepared` and requires the target header and default Files surface:

  ```ts
  await page.goto(`${origin(server)}/?scenario=review-prepared`);
  await expect(page.getByTestId("design-review-prepared")).toBeVisible();
  await expect(page.getByText("Snapshot · no GitHub writes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Checks · Failing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate walkthrough" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible();
  await expect(page.getByText("Files").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh GitHub state" })).toHaveCount(0);
  ```

- [ ] **Step 2: Run the focused test and verify RED.**

  Run:

  ```bash
  pnpm exec playwright test tests/browser/design.spec.ts --grep "prepared workbench target"
  ```

  Expected: FAIL because `review-prepared` still routes to `App` and exposes the old header controls.

- [ ] **Step 3: Create `DesignReviewJourneyScenario`.**

  Render a browser-only workbench with a Files rail, a bounded stored-diff fixture, and a local `overviewOpen` state. The header uses the approved target controls; check status opens the local overview, where refresh belongs.

  ```tsx
  export function DesignReviewJourneyScenario({ variant }: {
    readonly variant: "prepared" | "completed";
  }): React.JSX.Element {
    const [overviewOpen, setOverviewOpen] = useState(false);
    const [analysisStarted, setAnalysisStarted] = useState(false);
    const [publishPreviewOpen, setPublishPreviewOpen] = useState(false);

    return (
      <main data-testid={`design-review-${variant}`} className="min-h-screen bg-background">
        <header>
          <p>centraldigital/patchdesk#42</p>
          <Badge>Snapshot · no GitHub writes</Badge>
          <Button onClick={() => setOverviewOpen(true)}>Checks · Failing</Button>
          {variant === "prepared" ? <Button variant="outline">Generate walkthrough</Button> : null}
          {variant === "prepared" ? <Button onClick={() => setAnalysisStarted(true)}>Run analysis</Button> : null}
        </header>
        <DesignFilesSurface />
        {overviewOpen ? <DesignPrOverview onClose={() => setOverviewOpen(false)} /> : null}
        {analysisStarted ? <p role="status">Analysis started for this snapshot.</p> : null}
      </main>
    );
  }

  function DesignFilesSurface(): React.JSX.Element {
    return (
      <section aria-label="Files" className="grid grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Changed files"><Button variant="secondary">src/review.ts</Button></nav>
        <pre aria-label="Stored diff">@@ -34 +34 @@{`\n`}-old{`\n`}+new</pre>
      </section>
    );
  }
  ```

  `DesignPrOverview` contains `Refresh GitHub state`, PR description, check summary, and a close control. Its refresh button only updates a local status message.

- [ ] **Step 4: Add completed grouping to the same component.**

  For `variant === "completed"`, render three visible sections with `data-testid` values `design-understand`, `design-decide`, and `design-publish`. Use local state only to show a status that directs the reviewer to the existing `dialog-submit` scenario; Task 4 owns the Design publish dialogs.

  ```tsx
  <section data-testid="design-understand"><h2>Understand</h2><p>2 findings in the stored diff.</p><Button variant="outline">Open walkthrough</Button></section>
  <section data-testid="design-decide"><h2>Decide</h2><p>1 local comment is ready to review.</p><Button variant="outline">Review local batch</Button></section>
  <section data-testid="design-publish"><h2>Publish</h2><p>GitHub writes require a separate confirmation.</p><Button onClick={() => setPublishPreviewOpen(true)}>Review publish actions</Button>{publishPreviewOpen ? <p role="status">Open Submit review dialog to inspect the confirmation.</p> : null}</section>
  ```

- [ ] **Step 5: Route the existing IDs and update registry copy.**

  In `DesignApp`, route `review-prepared` and `review-completed` before the `return <App />` fallback. Keep IDs unchanged; change their registry descriptions to say `Run analysis`, `Walkthrough`, and `Publish` rather than `read-only snapshot` or `review run`.

- [ ] **Step 6: Add completed-state assertions and run GREEN.**

  Extend the focused test to open `?scenario=review-completed`, then assert all three groups and the absence of a header publish control.

  ```bash
  pnpm exec playwright test tests/browser/design.spec.ts --grep "workbench target"
  ```

  Expected: PASS with one primary prepared action and the completed Understand → Decide → Publish grouping.

- [ ] **Step 7: Commit the workbench target.**

  ```bash
  git add src/design/design-review-journey-scenario.tsx src/design/design-app.tsx src/design/scenarios.ts tests/browser/design.spec.ts
  git commit -m "feat: add review journey Design workbench"
  ```

## Task 2: Make recovery targets safe to leave and easy to distinguish

**Files:**

- Modify: `src/design/design-recovery.tsx`.
- Modify: `src/design/design-app.tsx`.
- Modify: `src/design/scenarios.ts`.
- Test: `tests/browser/design.spec.ts`.

**Interfaces:**

- `DesignRecoveryChip` accepts `primaryLabel`, `snapshotReadable`, `onBackToInbox`, and `onViewSnapshot` in addition to its Design fixture copy.
- `data-testid="back-to-inbox"` is always present in a workbench recovery scenario.
- `data-testid="view-snapshot"` is present only when `snapshotReadable === true`.

- [ ] **Step 1: Write failing recovery tests.**

  Replace the existing `Start again` and `Try again` expectations with the approved labels and exits:

  ```ts
  await page.goto(`${origin(server)}/?scenario=workbench-start-again`);
  await expect(page.getByRole("button", { name: "Restart interrupted analysis" })).toBeVisible();
  await expect(page.getByTestId("back-to-inbox")).toBeVisible();
  await expect(page.getByTestId("view-snapshot")).toBeVisible();

  await page.goto(`${origin(server)}/?scenario=workbench-prepare-again`);
  await expect(page.getByRole("button", { name: "Prepare again" })).toBeVisible();
  await expect(page.getByTestId("back-to-inbox")).toBeVisible();
  await expect(page.getByTestId("view-snapshot")).toHaveCount(0);
  ```

- [ ] **Step 2: Run the recovery test and verify RED.**

  ```bash
  pnpm exec playwright test tests/browser/design.spec.ts --grep "workbench recovery"
  ```

  Expected: FAIL because the existing Design chip only renders the legacy action and no safe exit.

- [ ] **Step 3: Add Design-only target recovery metadata.**

  Keep the existing shared renderer copy untouched. In `design-recovery.tsx`, define a local map keyed by the existing scenario IDs:

  ```ts
  const RECOVERY_TARGETS = {
    "workbench-reconnect": { label: "Reconnect", snapshotReadable: true },
    "workbench-start-again": { label: "Restart interrupted analysis", snapshotReadable: true },
    "workbench-try-again": { label: "Retry failed analysis", snapshotReadable: true },
    "workbench-prepare-again": { label: "Prepare again", snapshotReadable: false },
  } as const;
  ```

  Render `Back to inbox` as a secondary button for every target. Render `View snapshot` only for targets with a readable snapshot. Each control sets a local status message; no bridge call occurs.

- [ ] **Step 4: Update the recovery scenario header and registry copy.**

  Make `DesignWorkbenchRecoveryScenario` consume the target panel and change scenario labels to `interrupted analysis` and `failed analysis`. Do not remove the scenario IDs.

- [ ] **Step 5: Run the focused recovery test and verify GREEN.**

  ```bash
  pnpm exec playwright test tests/browser/design.spec.ts --grep "workbench recovery"
  ```

  Expected: PASS. The primary label explains why recovery differs, and no recovery view traps the maintainer.

- [ ] **Step 6: Commit the recovery target.**

  ```bash
  git add src/design/design-recovery.tsx src/design/design-app.tsx src/design/scenarios.ts tests/browser/design.spec.ts
  git commit -m "feat: refine Design recovery states"
  ```

## Task 3: Make walkthrough targets strictly for reading

**Files:**

- Modify: `src/design/design-walkthrough-scenario.tsx`.
- Modify: `src/design/scenarios.ts`.
- Test: `tests/browser/design.spec.ts`.

**Interfaces:**

- `data-testid="walkthrough-reading-surface"` exists only in the `ready` lifecycle.
- `data-testid="walkthrough-primary-action"` identifies the one failed/stale lifecycle action.
- `data-testid="walkthrough-advanced-options"` identifies the disclosure containing per-run model and reasoning overrides.
- `readSectionIds: ReadonlyArray<string>`, `supportRead: boolean`, and `toggleCurrentSectionRead(): void` hold Design-only reading progress.

- [ ] **Step 1: Write failing walkthrough tests.**

  Add tests that assert the intended separation:

  ```ts
  await page.goto(`${origin(server)}/?scenario=walkthrough-failed`);
  await expect(page.getByTestId("walkthrough-primary-action")).toHaveText("Retry generation");
  await expect(page.getByRole("button", { name: "Retry generation" })).toHaveCount(1);
  await expect(page.getByTestId("walkthrough-reading-surface")).toHaveCount(0);

  await page.goto(`${origin(server)}/?scenario=walkthrough-stale`);
  await expect(page.getByRole("button", { name: "Regenerate walkthrough" })).toHaveCount(1);
  await expect(page.getByText("Why this snapshot matters")).toHaveCount(0);
  ```

- [ ] **Step 2: Run the walkthrough edge-state test and verify RED.**

  ```bash
  pnpm exec playwright test tests/browser/design.spec.ts --grep "walkthrough edge states"
  ```

  Expected: FAIL because failed and stale currently duplicate the action and retain the chapter rail.

- [ ] **Step 3: Reshape lifecycle rendering.**

  Change the takeover so only `ready` renders `ChapterList`, `SupportList`, and `SectionPane`. Failed, stale, and generating render a compact status panel plus `Back to files`; failed and stale each render their one lifecycle action in the header only.

  ```tsx
  const showReadingSurface = lifecycle === "ready";

  {showReadingSurface ? (
    <div data-testid="walkthrough-reading-surface" data-layout="rail">
      <ChapterList sections={sections} currentId={current} readSectionIds={readSectionIds} onSelect={setCurrent} />
      <SectionPane section={currentSection} isRead={readSectionIds.includes(currentSection.id)} onToggleRead={toggleCurrentSectionRead} canGoPrev={canGoPrev} canGoNext={canGoNext} onPrev={selectPreviousSection} onNext={selectNextSection} />
    </div>
  ) : (
    <WalkthroughStatusPanel lifecycle={lifecycle} />
  )}
  ```

  Remove the action buttons from the failed and stale alerts.

- [ ] **Step 4: Remove review-batch affordances and rename reading progress.**

  Replace `reviewed` with `readSectionIds`, replace `supportReviewed` with `supportRead`, and add `toggleCurrentSectionRead(): void` beside the existing next/previous helpers. Delete the `Add inline comment` button and its explanatory text from `SectionPane`. Rename `Mark section reviewed` to `Mark section as read`, `Reviewed` to `Read`, and `Mark Support reviewed` to `Mark support as read`. Keep only local state that supports those read marks.

- [ ] **Step 5: Make generation defaults quiet and overrides advanced-only.**

  In the dialog, render the selected model and reasoning as a short default summary. Place the existing `Select` controls inside a closed `Collapsible` with a button named `Advanced options`.

  ```tsx
  <p>Uses Design review model with Medium reasoning.</p>
  <Collapsible data-testid="walkthrough-advanced-options">
    <CollapsibleTrigger render={<Button variant="outline" />}>Advanced options</CollapsibleTrigger>
    <CollapsibleContent>
      <Label>Model<Select value={model} onValueChange={setModel}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pi-design">Design review model</SelectItem><SelectItem value="pi-balanced">Balanced reasoning model</SelectItem></SelectContent></Select></Label>
      <Label>Reasoning<Select value={reasoning} onValueChange={setReasoning}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select></Label>
    </CollapsibleContent>
  </Collapsible>
  ```

- [ ] **Step 6: Extend interactions and run GREEN.**

  Update existing ready-state tests to use the `as read` labels. Add a dialog test that confirms no combobox is visible until `Advanced options` opens.

  ```bash
  pnpm exec playwright test tests/browser/design.spec.ts --grep "walkthrough"
  ```

  Expected: PASS for ready navigation, read marks, one-action failed/stale states, and advanced-only overrides.

- [ ] **Step 7: Commit the walkthrough target.**

  ```bash
  git add src/design/design-walkthrough-scenario.tsx src/design/scenarios.ts tests/browser/design.spec.ts
  git commit -m "feat: simplify Design walkthrough states"
  ```

## Task 4: Build concrete publish-confirmation targets

**Files:**

- Create: `src/design/design-publish-confirmation-scenario.tsx`.
- Modify: `src/design/design-app.tsx`.
- Modify: `src/design/scenarios.ts`.
- Test: `tests/browser/design.spec.ts`.

**Interfaces:**

- `type DesignPublishConfirmationVariant = "submit" | "merge"`.
- `DesignPublishConfirmationScenario({ variant }: { readonly variant: DesignPublishConfirmationVariant }): React.JSX.Element`.
- `data-testid="design-submit-confirmation"` and `data-testid="design-merge-confirmation"` identify the dialogs.

- [ ] **Step 1: Write failing publish-confirmation tests.**

  ```ts
  await page.goto(`${origin(server)}/?scenario=dialog-submit`);
  await expect(page.getByTestId("design-submit-confirmation")).toContainText(
    "2 inline comments · 1 reply · 1 thread change",
  );

  await page.goto(`${origin(server)}/?scenario=dialog-merge`);
  await expect(page.getByTestId("design-merge-confirmation")).toContainText(
    "Required checks are failing",
  );
  await expect(page.getByLabel("I acknowledge that required checks are failing")).toBeVisible();
  ```

- [ ] **Step 2: Run the publish test and verify RED.**

  ```bash
  pnpm exec playwright test tests/browser/design.spec.ts --grep "publish confirmation target"
  ```

  Expected: FAIL because the current Design routes reuse renderer fixtures that show no concrete batch count and a generic merge warning.

- [ ] **Step 3: Create a Design-only dialog surface.**

  Use the existing `Dialog`, `Alert`, `Checkbox`, and `Button` primitives. The submit variant renders the immutable local summary `2 inline comments · 1 reply · 1 thread change` and changes only a local status message after confirmation. The merge variant renders PR, branch, SHA, merge method, and separate warnings:

  ```tsx
  const mergeWarnings = [
    "Required checks are failing",
    "1 high-severity finding remains",
  ] as const;
  ```

  The acknowledgement label names the first blocking warning. Confirm changes only local `status` text; it never calls `requestJson`.

- [ ] **Step 4: Route existing dialog IDs to the target surface.**

  Replace `SubmissionFixture` and `MergeConfirmationDialog` imports in `design-app.tsx` with the new Design-only component for `dialog-submit` and `dialog-merge`. Keep the registry IDs stable and update their descriptions with `exact saved actions` and `exact merge warning`.

- [ ] **Step 5: Run focused tests and verify GREEN.**

  ```bash
  pnpm exec playwright test tests/browser/design.spec.ts --grep "publish confirmation target"
  ```

  Expected: PASS with concrete pre-confirmation content and no network call.

- [ ] **Step 6: Commit the publish target.**

  ```bash
  git add src/design/design-publish-confirmation-scenario.tsx src/design/design-app.tsx src/design/scenarios.ts tests/browser/design.spec.ts
  git commit -m "feat: add Design publish confirmations"
  ```

## Task 5: Verify the whole Design reference

**Files:**

- Modify: `tests/browser/design.spec.ts` only if assertions from earlier tasks need consolidation.

- [ ] **Step 1: Update registry assertions.**

  Preserve the expected count and all 22 existing IDs. Update user-facing expected labels from `Run review`, `Start again`, `Try again`, `Reviewed`, and `Show generate dialog` to the approved vocabulary.

- [ ] **Step 2: Run the complete Design suite.**

  ```bash
  pnpm test:design
  ```

  Expected: every stable Design route loads, records no console error, and passes the revised interaction assertions.

- [ ] **Step 3: Run static project checks.**

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test -- --run tests/browser/design.spec.ts
  ```

  Expected: all commands pass. If the browser test is not accepted by the Vitest command, record that it is Playwright-only and retain the passing `pnpm test:design` evidence.

- [ ] **Step 4: Perform live Design QA with a dedicated tester.**

  Start `pnpm dev:design` in a named tmux pane. A dedicated tester captures prepared, completed, interrupted, failed walkthrough, stale walkthrough, submit, and merge states. The primary agent does not perform live browser interaction.

- [ ] **Step 5: Compare the live capture with the approved spec.**

  Confirm Files is the prepared default, one action appears for every recovery/walkthrough state, the stale state has no reading content, and publish dialogs name the actual action or warning.

- [ ] **Step 6: Commit final test-only changes.**

  ```bash
  git add tests/browser/design.spec.ts
  git commit -m "test: cover review journey Design states"
  ```

## Coverage review

- Prepared snapshot vocabulary and action hierarchy: Task 1.
- Completed Understand → Decide → Publish grouping: Task 1.
- Safe recovery exits and distinct recovery labels: Task 2.
- One-action, stale-safe, strictly reading-only walkthrough: Task 3.
- Advanced-only walkthrough overrides: Task 3.
- Concrete submit and merge confirmation context: Task 4.
- Stable Design registry, automated proof, and dedicated live QA: Task 5.

The plan deliberately does not modify production renderer behavior. It gives the team a working Design reference that can be approved before the corresponding renderer implementation begins.
