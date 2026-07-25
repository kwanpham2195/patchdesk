---
created_at: 2026-07-24
repos:
  - patchdesk
status: draft
plan: .agents/PLANS/2026-07-24-patchdesk-review-architecture.md
---

# Patchdesk review architecture deepening technical design

## Summary

This design separates three overloaded paths without changing Patchdesk’s safety boundaries:

1. **Review Session preparation** creates or resumes an immutable, read-only Session.
2. **Workbench projection** builds the bounded renderer read model for an existing Session.
3. **Completed-review interaction** owns the local renderer state that coordinates findings, evidence, drafts, and navigation protection.
4. **Renderer screen flows** own their API sequencing and local UI state, leaving `App` as the destination and cross-screen-navigation composition root.

The design intentionally allows breaking development-only local Sessions, local preferences, routes, fixtures, and internal component props. It deletes replaced paths rather than adding migrations, aliases, fallback reads, or dual writes. It does not change review Attempt semantics, GitHub-write confirmation, renderer isolation, local API authentication, Pierre hook ownership, or desktop geometry.

## Context / current state

`ReviewWorkbenchController` currently does four jobs:

- parses the review-opening request;
- loads a profile and current pull request;
- resumes or prepares a Session, including incremental comparison work and immutable artifacts;
- projects prepared or completed Session state for the renderer.

`ReviewSessionService` owns part of preparation, including Session creation, worktree preparation, patch/context writes, and Session persistence. The controller owns the rest, including resume decisions, incremental scope selection, and the head recheck around comparison persistence.

`ReviewWorkbench` receives a wide prop object and owns selected finding/file/range, filters, local Fix queue state, view preferences, collapsed paths, draft-save state, write-pending state, and child composition. `App` then maps the local-API workbench projection into those props while also owning Inbox, settings, profile, model, dialog, fixture, and route state.

The current product behavior to preserve:

- Opening or loading a Workbench is read-only. It never starts, restarts, completes, discards, or mutates an Attempt.
- A Review Session is immutable with respect to its reviewed head and saved preparation artifacts.
- A completed saved review remains readable when a local patch is absent. The product must not silently rerun preparation or a model to render it.
- A current-head mismatch blocks unsafe work but leaves saved evidence readable.
- Renderer content receives only bounded local-API projections. It has no shell, GitHub token, direct GitHub API, repository-path, or raw provider capability.
- The diff boundary retains its dedicated immutable-context hydration, progressive stream, and QA scroll-diagnostic hooks.

## Goals

- Give Session preparation one owner for resume, full/incremental scope, current-head verification, immutable artifact persistence, and truthful fallback behavior.
- Give Workbench projection one owner for assembling prepared and completed renderer-safe data.
- Give the completed-review surface one local interaction owner with a compact model and cohesive actions.
- Make `App` a smaller composition root whose child flows own screen-specific requests and state.
- Preserve existing observable review-safety behavior through real-seam tests and packaged-Electron QA.

## Non-goals

- New product features, external dependencies, framework-wide renderer state, generic repositories, route-registration modules, or a service for every noun.
- Strict parsing of the review-opening HTTP command. It remains a separate deferred improvement; this design keeps the current controller parse behavior at that boundary.
- Compatibility for existing development data. Do not create migrations, dual reads, fallback aliases, or persistence shims.
- Moving Pierre responsibilities out of its existing hooks or changing the 1,000-file performance ceiling.
- Modifying GitHub-write operations, merge confirmation, review-run allocation, model catalog behavior, or local API authentication/origin checks.

## Invariants

1. **Read-only inspection:** `open` and `load` do not cause workflow invocation or Attempt mutation.
2. **Immutable Session identity:** the Session key and saved artifacts identify one exact head. A changed current head becomes a typed failure or stale projection, never a silent artifact rewrite.
3. **Honest incremental review:** an incomplete/unavailable incremental comparison follows the current accepted full-review fallback. It does not produce a misleading partial incremental Session.
4. **Safe projection:** missing GitHub reads degrade to existing bounded safe values. Raw dependency errors, local paths, prompt data, provider events, and credentials never reach the renderer.
5. **Write safety:** stale/unavailable freshness and dirty/write-pending draft state continue to block or guard navigation and writes.
6. **One review-local state owner:** only the completed-review interaction owns its selected finding/file/range, filter, collapsed-path, local Fix queue, and write-navigation state.
7. **One screen-flow owner:** a screen owns its fetch lifecycle and local loading/error state. Root-level code does not recreate it.

## Design constraints

- TypeScript uses the existing `Result` tagged union. Expected failures remain typed values, not rejected promises.
- Dependencies are constructor-injected and narrowed to the behavior consumed.
- `local-api.ts` remains the authenticated protocol/composition boundary. It owns HTTP response projection but not Session workflow policy.
- The renderer preserves `nodeIntegration: false` and `contextIsolation: true`; new screen flows use the existing typed bridge/API client only.
- Existing Base Nova primitives and current 1280px geometry remain unchanged. UI structure can change only within the local surfaces.
- Time is injected where it affects a projection. No module reads ambient runtime configuration or credentials.
- Tests exercise public service/component seams and recording/fake adapters already used by the project. Do not use module mocks or spies.

## Alternatives considered

### Option 1: retain `ReviewWorkbenchController` and only extract helpers

Extract pure helpers for scope selection, artifact creation, and renderer props while keeping the controller as the policy owner.

**Why not:** helper extraction reduces line count but leaves callers and tests coupled to a controller that still knows parsing, Session workflow ordering, persistence, GitHub reads, and projection. The deletion test fails because deleting the helpers merely inlines logic back into the controller.

### Option 2: introduce generic repositories and route registrars

Create a `ReviewRepository`, `WorkbenchRepository`, route modules, and a renderer-global store.

**Why not:** these add interfaces without hiding policy. They would expose persistence and protocol details to use-case code, split a small security-sensitive HTTP surface, and turn review-local state into global mutable state. Most modules would be thin forwarding wrappers.

### Option 3: bounded preparation/projection services plus renderer flow containers

Create a Session-preparation Service Module, a Workbench-projection Service Module, a review-local interaction hook/container, and focused renderer screen flows. Keep the controller and root as thin composition/translation surfaces.

**Recommendation:** choose Option 3. Each interface hides a substantial ordered workflow, has a real consumer, and improves behavior-focused testing.

## Recommendation

Adopt Option 3 in three independently landable changes:

1. replace the mixed preparation/projection ownership with `ReviewSessionPreparation` and `ReviewWorkbenchProjection`;
2. replace the completed-review prop/state bag with `CompletedReviewWorkbench` and its review-local interaction owner;
3. extract Inbox, prepared-review, completed-review, settings, and fixture flows from `App`.

The old `ReviewSessionService` and mixed private controller paths are deleted after the new services become the only path. The public local API routes and their existing response behavior remain stable within this plan, even though the internal classes and renderer component props may change.

## Proposed design

### 1. Session preparation

`ReviewSessionPreparation` owns the workflow that turns a refined selection into an existing or newly prepared immutable Session. It is the only module that decides whether a stored Session is reusable, whether an incremental comparison is complete enough, and when a current-head recheck is required before writing a new Session.

It does not project renderer data, create a Review Attempt, start a workflow, or map HTTP responses.

```ts
export type ReviewOpenMode =
  | { readonly kind: "full" }
  | { readonly kind: "incremental"; readonly baseSessionId: ReviewSessionId };

/** A refined local application command. The existing controller constructs it. */
export type PrepareReviewSessionInput = {
  readonly profileId: WorkspaceProfileId;
  readonly pullRequest: PullRequestRef;
  readonly mode: ReviewOpenMode;
};

export type PreparedReviewSession = {
  readonly session: ReviewSession;
  readonly disposition: "resumed" | "prepared";
};

export type PrepareReviewSessionFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "InvalidIncrementalBase" }
  | { readonly _tag: "GitHubReadUnavailable" }
  | { readonly _tag: "HeadChanged" }
  | { readonly _tag: "SessionStorageUnavailable" }
  | { readonly _tag: "PreparationUnavailable" }
  | { readonly _tag: "PreparationCleanupUnavailable" };

/** Prepares or resumes an immutable, read-only Session. Never mutates an Attempt. */
export class ReviewSessionPreparation {
  constructor(/* narrow profile/session/GitHub/worktree/context/comparison dependencies */) {}

  prepare(
    input: PrepareReviewSessionInput,
  ): Promise<Result<PreparedReviewSession, PrepareReviewSessionFailure>>;
}
```

The class privately:

1. loads the profile and reads the current pull request;
2. derives the Session ID from profile, pull-request identity, and current head;
3. serializes preparation by `(profileId, derivedSessionId)` across the remaining steps;
4. loads the matching stored Session and returns it only when it is honestly reusable under the existing completed/prepared rules;
5. creates a durable preparation journal and resolves requested incremental scope, including prior-finding evidence, into a journal-owned staging location rather than final Session artifact paths;
6. rechecks the current head immediately before committing immutable artifacts;
7. promotes staged comparison artifacts and creates final Session patch, context, review-input/debug, and managed-worktree artifacts, recording each created/promoted target in the journal;
8. persists the Session only after every final artifact exists, then marks the journal committed and removes it;
9. on head change or any failure before commit, removes every journal-recorded staging and final artifact; a cleanup failure retains the journal for startup recovery and returns `PreparationCleanupUnavailable`;
10. returns `resumed` or `prepared`.

The implementation may reuse the existing worktree, context, artifact, comparison, storage, and GitHub adapters. It may not retain the old `ReviewSessionService.startReview` path after adoption.

### Preparation commit and cleanup protocol

Filesystem promotion and Session JSON persistence are not one transaction. `ReviewSessionPreparation` therefore owns a small durable preparation journal under Patchdesk-managed storage. The journal contains only the Session ID, lifecycle state, and paths generated by `PatchdeskPaths`; it is never projected to the renderer or logged.

- **Before any artifact write:** create the journal with a staging root and an empty final-target list.
- **For every staged/promoted/final artifact:** append the generated path to the journal before the next effect. This includes comparison patch/metadata, previous-findings/lifecycle files, full patch, prepared context, review input, debug file, and managed worktree.
- **Before Session save:** recheck the pull-request head and remove every recorded target if it changed.
- **After every final artifact exists:** save the Session atomically, mark the journal committed, then remove the journal.
- **If a final artifact creation, promotion, or Session save fails:** remove every recorded staging and final target in reverse dependency order. A successful cleanup leaves no unreferenced artifact.
- **If cleanup itself fails or the process stops mid-cleanup:** retain the journal. Startup recovery owns retrying its generated targets before exposing the Session as prepared. The journal is not a compatibility path and may not make a Session reusable.

The recovery path reports only a safe typed preparation/storage state. It never starts a model, rewrites a Session to point at staged data, or exposes cleanup paths to the renderer.

### 2. Workbench projection

`ReviewWorkbenchProjection` is a read-side Service Module. It accepts a stored Session, reads its bounded saved artifacts plus current GitHub context, and returns the discriminated renderer model. It owns safe defaults, freshness, comparison availability, merge-readiness calculation, and projection of attempts to bounded history items.

It does not prepare a Session, make scope choices, persist artifacts, or mutate a draft/Attempt.

```ts
export type LoadWorkbenchInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
};

export type WorkbenchProjectionFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "SessionNotFound" }
  | { readonly _tag: "SessionStorageUnavailable" };

/** Renderer-safe Session identity. It deliberately omits patch/worktree paths and durable internals. */
export type WorkbenchSessionProjection = {
  readonly id: ReviewSessionId;
  readonly key: {
    readonly profileId: WorkspaceProfileId;
    readonly host: GitHubHost;
    readonly owner: GitHubOwner;
    readonly repo: GitHubRepoName;
    readonly prNumber: PullRequestNumber;
    readonly headSha: GitSha;
  };
  readonly currentAttemptId?: ReviewAttemptId;
};

/** Renderer-safe scope metadata. Artifact paths stay in the main process. */
export type ReviewScopeProjection =
  | { readonly kind: "full" }
  | {
      readonly kind: "incremental";
      readonly baseSessionId: ReviewSessionId;
      readonly baseHeadSha: GitSha;
      readonly headSha: GitSha;
    };

export type PreparedWorkbenchProjection = {
  readonly state: "review_started";
  readonly session: WorkbenchSessionProjection;
  readonly fullPatch?: string;
  readonly pullRequest?: PullRequestSummary;
  readonly reviewedHeadSha: GitSha;
  readonly currentHeadSha?: GitSha;
  readonly freshness: "fresh" | "stale" | "unavailable";
  readonly refreshedAt: IsoTimestamp;
  readonly checks: CheckSummary;
};

export type CompletedWorkbenchProjection = {
  readonly state: "completed";
  readonly session: WorkbenchSessionProjection;
  readonly result: ReviewResult;
  readonly reviewScope: ReviewScopeProjection;
  readonly fullPatch?: string;
  readonly comparison?: RevisionComparison;
  readonly comparisonPatch?: string;
  readonly lifecycle?: ReadonlyArray<FindingLifecycleEntry>;
  readonly comparisonAvailability:
    | "available"
    | "not_requested"
    | "incomplete"
    | "missing";
  readonly pullRequest?: PullRequestSummary;
  readonly reviewedHeadSha: GitSha;
  readonly currentHeadSha?: GitSha;
  readonly freshness: "fresh" | "stale" | "unavailable";
  readonly refreshedAt: IsoTimestamp;
  readonly draft: ReviewDraft;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly history: ReadonlyArray<ReviewHistoryItem>;
  readonly mergeReadiness: MergeReadiness;
};

export type ReviewWorkbenchProjection =
  | PreparedWorkbenchProjection
  | CompletedWorkbenchProjection;

/** Reads a safe Workbench model for one persisted Session. Never prepares or runs it. */
export class ReviewWorkbenchProjection {
  constructor(/* narrow profile/session/GitHub/filesystem/clock dependencies */) {}

  load(
    input: LoadWorkbenchInput,
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>>;
}
```

`ReviewHistoryItem` becomes a named projection type instead of a conditional `Awaited<ReturnType<...>>` inference leaking GitHub adapter mechanics into the public Workbench model. The service constructs explicit safe projections for checks, comments, pull-request fallback, and history.

### 3. Existing controller after Milestone 1

The existing `ReviewWorkbenchController` remains only until the deferred local-API parser work replaces it. It has two responsibilities: retain current parsing behavior and map the precise new failure union to the existing local-API-visible failure vocabulary.

```ts
/** Temporary local-API application facade; retains the current unknown-input parser. */
export class ReviewWorkbenchController {
  constructor(
    private readonly preparation: ReviewSessionPreparation,
    private readonly projection: ReviewWorkbenchProjection,
  ) {}

  open(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>>;
  load(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>>;
}
```

`open` parses exactly as it does today, creates `PrepareReviewSessionInput`, invokes `preparation.prepare`, and then invokes `projection.load` for the returned Session ID. The controller does not read GitHub, compare revisions, read files, or persist Sessions directly. `load` parses the existing request and delegates straight to projection.

This is intentionally a narrow boundary facade, not a general new application layer. Its deletion is part of the deferred strict-parser change, not this plan.

### 4. Completed-review interaction

The renderer exposes one model and one action set to the completed-review surface. It uses a review-local hook/container to own all mutable selection/navigation state. Presentational children receive only the model they render and callbacks that change their local concern.

```ts
export type CompletedReviewWorkbenchModel = {
  readonly source: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
  };
  readonly workbench: CompletedWorkbenchProjection;
};

export type CompletedReviewWorkbenchActions = {
  readonly saveDraft: (input: {
    readonly expectedRevision: string;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<{
      readonly findingId: string;
      readonly include: boolean;
      readonly body: string;
    }>;
  }) => Promise<{ readonly draft: ReviewDraft; readonly revision: string }>;
  readonly createPendingReview: () => Promise<{ readonly reviewId: string }>;
  readonly submitPendingReview: (
    event: GitHubReviewEvent,
    summaryBody: string,
  ) => Promise<{ readonly reviewId: string }>;
  readonly merge?: (
    method: MergeMethod,
    acknowledgedWarnings: boolean,
  ) => Promise<{ readonly mergeCommitSha?: string }>;
  readonly reportNavigationState: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
};

/** Owns completed-review interaction state; it does not fetch, prepare, or project data. */
export function CompletedReviewWorkbench(
  props: {
    readonly model: CompletedReviewWorkbenchModel;
    readonly actions: CompletedReviewWorkbenchActions;
  },
): React.JSX.Element;
```

These signatures mirror the existing renderer callbacks. The parent flow owns local-API error translation and presentation through the established API client; this component does not create a second draft, merge, or submission failure model.

The local interaction owner owns:

- selected finding, file, and evidence range;
- finding filters and derived visible findings;
- active full/incremental diff surface;
- collapsed file paths and review view preferences;
- local Fix queue state;
- draft save and write pending state;
- reporting the derived navigation state to the root.

It does not own Session freshness, review results, comparisons, GitHub checks/comments, model execution, or app navigation destination. Those enter through `CompletedWorkbenchProjection` or the action set.

### 5. Renderer screen flows

`App` remains the root component and owns only:

- `AppDestination` persistence/selection;
- active-profile handoff required across screens;
- global appearance application;
- cross-screen dirty-draft/write-pending guard;
- the shell and top-level dialog placement.

Focused flow components own their API calls and local state:

```txt
App
├── InboxFlow
├── PreparedReviewFlow
├── CompletedReviewFlow
├── ReviewHistoryFlow
├── SettingsFlow
└── FixtureRoute (development/browser only)
```

`PreparedReviewFlow` owns the run-review dialog, model-catalog request, selected model/reasoning preference, and dialog-local errors because they are meaningful only while inspecting one prepared review. `App` retains only global appearance and cross-screen navigation-guard state. Each flow receives typed inputs and callbacks. For example, `CompletedReviewFlow` loads the bounded workbench projection and transforms it into `CompletedReviewWorkbenchModel` plus actions. It owns request generation/cancellation guards so an obsolete response cannot overwrite a newer Session selection. `App` does not reconstruct `ReviewWorkbench`’s former prop list.

The API client and `renderer-contracts.ts` remain renderer boundaries. Flows parse concrete endpoint projections before putting values in React state. They never pass raw response values to children.

## Seams, boundaries, adapters, and implementations

- **HTTP/local API:** `local-api.ts` plus the temporary controller accepts authenticated JSON and returns the current bounded response DTO. Credentials, raw errors, and filesystem paths do not cross.
- **Session workflow:** `ReviewSessionPreparation` accepts a refined review selection and returns an immutable Session/result. HTTP, Hono, Electron, and renderer objects do not cross.
- **Session storage, GitHub, and worktree:** established adapters receive narrow behavior calls and return typed adapter values. Raw adapter DTOs do not cross into the renderer.
- **Workbench read model:** `ReviewWorkbenchProjection` accepts Session identity and returns a discriminated safe projection. Preparation policy and workflow start do not cross.
- **Renderer API:** the API client and `renderer-contracts.ts` turn unknown JSON into a refined renderer projection. Unparsed JSON does not cross.
- **Completed-review interaction:** `CompletedReviewWorkbench` accepts a completed projection plus actions and returns UI events/navigation state. Session persistence, GitHub reads, and Pierre internals do not cross.
- **Pierre diff:** the existing view and hooks accept parsed diff/model selection and render the diff. Global state, wheel interception, and raw repository data do not cross.

The local-API response maps `ReviewSession` and `ReviewScope` through `WorkbenchSessionProjection` and `ReviewScopeProjection` before serialization. `renderer-contracts.ts` must strictly reject `patchPath`, `worktree`, and every incremental artifact-path field. The `local-api.ts` composition root creates preparation/projection services with existing adapters. Splitting its route declarations is not part of this design.

## Call stacks and data flow

### Current open flow

```txt
raw POST /v1/reviews/open body
  -> ReviewWorkbenchController.open(unknown)
  -> parse individual fields
  -> profile + GitHub read
  -> Session resume / incremental comparison / ReviewSessionService.startReview
  -> controller project or projectPrepared
  -> local API response
  -> App state
  -> wide ReviewWorkbench props
```

The same controller owns application workflow and projection behavior.

### Proposed open flow

```txt
raw POST /v1/reviews/open body
  -> local API auth/origin boundary
  -> ReviewWorkbenchController.open(unknown) [existing parser retained]
  -> PrepareReviewSessionInput
  -> ReviewSessionPreparation.prepare(input)
     -> ProfileStore + GitHubReader + ReviewSessionStore
     -> ReviewComparisonService / ReviewWorktreeService / ReviewContextService
     -> immutable ReviewSession persisted
  -> LoadWorkbenchInput
  -> ReviewWorkbenchProjection.load(input)
     -> session artifacts + GitHub reads + attempt history
     -> PreparedWorkbenchProjection | CompletedWorkbenchProjection
  -> local API response projection
  -> renderer contract parser
  -> PreparedReviewFlow | CompletedReviewFlow
  -> CompletedReviewWorkbench model + actions
```

### Proposed load flow

```txt
raw POST /v1/reviews/load body
  -> local API auth/origin boundary
  -> temporary controller existing parse
  -> LoadWorkbenchInput
  -> ReviewWorkbenchProjection.load(input)
  -> safe local API response
  -> renderer contract parser
  -> selected screen flow
```

No `load` stack calls preparation, Session persistence, Attempt allocation, a workflow, a GitHub writer, or a shell command.

### Failure flow

```txt
adapter typed failure
  -> precise preparation/projection failure
  -> temporary controller maps to existing route reason
  -> local API chooses existing status/projection
  -> renderer shows existing safe unavailable/stale/error state
```

Expected failures remain values. Filesystem/GitHub exception handling stays in their existing adapters or localized effect boundary. Raw causes are not serialized or rendered.

### Retry, cancellation, and idempotency

- `ReviewSessionPreparation.prepare` is idempotent for a given current Session identity: a reusable immutable Session returns `resumed`; it never allocates an Attempt.
- Current-head rechecks prevent a long comparison/preparation sequence from persisting a Session for a changed pull request.
- No automatic retry is introduced for GitHub, filesystem, or comparison failures. A user may repeat the explicit open action.
- Renderer flows retain current active/request-generation guards. On destination/profile/session change, an obsolete completed request must not overwrite current flow state.
- The root navigation guard remains the sole cross-screen authority for dirty drafts and write-pending work. A completed-review flow reports state; it does not navigate around the guard.

### Observability and safe diagnostics

This design adds no provider or GitHub telemetry payload. Existing safe run projections remain unchanged. If preparation/projection logging exists, it may record stable failure tags and Session IDs only when current project conventions allow; it must not log raw request bodies, patch content, repository paths, prompt data, credentials, provider events, or hidden reasoning.

## Files to add, change, and delete

### Add

- `src/services/review-session-preparation.ts`: Session preparation Service Module, its refined input/result/failure contracts, and private sequencing.
- `src/services/review-workbench-projection.ts`: safe prepared/completed Workbench read-model Service Module and explicit projection types.
- A focused Patchdesk-paths/journal/recovery module or narrow extension of the existing review recovery boundary: durable preparation journal creation and startup cleanup of incomplete preparation.
- `src/renderer/src/components/completed-review-workbench.tsx`: completed-review interaction owner/container with compact model/actions surface.
- Focused renderer flow files under `src/renderer/src/flows/` or the established adjacent component location. Exact placement follows the current import and test convention; do not introduce a barrel.
- Focused tests for each new Service Module and renderer flow using existing test layout conventions.

### Change

- `src/services/review-workbench-controller.ts`: retain only existing request parsing and delegation/failure mapping.
- `src/main/local-api.ts`: compose the new services; route behavior/security remains unchanged.
- `src/renderer/src/app.tsx`: retain root duties only and compose flows. Move run-dialog/model-catalog/preference state to `PreparedReviewFlow`.
- `src/renderer/src/renderer-contracts.ts`: accept only `WorkbenchSessionProjection` and `ReviewScopeProjection`; reject path-bearing fields.
- `src/renderer/src/components/review-workbench.tsx`: replace or reduce to a presentational child after `CompletedReviewWorkbench` becomes the sole completed-review interaction owner.
- Existing controller, service, renderer, browser, and package tests: assert behavior at the new real seams.

### Delete

- `src/services/review-session-service.ts` after all preparation behavior has moved to `ReviewSessionPreparation`.
- Mixed private preparation/projection methods from `ReviewWorkbenchController`.
- Root-owned duplicate completed-review/screen-flow state.
- Superseded wide prop wiring and tests that assert internal call structure rather than user-visible behavior.

No config, database migration, persistence migration, or runtime permission change is planned.

## RGR TDD test plan

### Slice 1: resume an immutable Session

**Red:** a `ReviewSessionPreparation` test opens a matching prepared/completed Session and asserts `disposition: "resumed"`, no worktree/context write, no Attempt mutation, and no workflow call.

**Green:** move resume eligibility into the new preparation Service Module.

**Refactor:** delete the controller’s direct stored-session handling after the service is the only owner.

### Slice 2: prepare full and incremental Sessions honestly

**Red:** focused behavior tests drive a full input and a complete incremental input through preparation with existing recording/fake GitHub and storage seams. They prove immutable artifact/session persistence, prior-finding evidence only for the incremental path, and concurrent opens yield one prepared Session without a competing worktree failure. Inject a failure after each journalled effect: journal creation, comparison creation/promotion, patch/context/review-input/debug creation, managed-worktree creation, Session save, journal commit, and each cleanup deletion. Assert successful cleanup leaves no staging or final artifact; a failed cleanup retains only a non-renderable journal that startup recovery removes before the Session can be treated as prepared.

**Green:** move scope resolution, journalled staged comparison persistence, keyed preparation serialization, recheck, artifact commit/cleanup, and artifact creation into preparation.

**Refactor:** delete `ReviewSessionService`; retain no compatibility path for development data.

### Slice 3: project prepared and completed Sessions

**Red:** tests call `ReviewWorkbenchProjection.load` through its public API and prove: saved completed result remains readable with a missing patch; unavailable GitHub produces existing safe checks/comments/freshness; stale head blocks write affordances but preserves evidence; missing/incomplete comparison has truthful availability.

**Green:** move `project` and `projectPrepared` behavior into projection.

**Refactor:** replace conditional adapter-return inferred types with named projection types.

### Slice 4: preserve local API behavior

**Red:** local API integration tests exercise open/load with current accepted request bodies and assert their existing response/failure behavior. They verify neither route changes an Attempt or invokes a workflow, and assert the serialized response exposes no patch path, worktree path, or incremental artifact path. `renderer-contracts.ts` tests reject every such path-bearing field.

**Green:** compose preparation/projection and reduce the controller to delegation.

**Refactor:** remove direct controller dependencies on GitHub, storage, paths, comparison, and filesystem.

### Slice 5: completed-review interaction behavior

**Red:** renderer tests interact with `CompletedReviewWorkbench` as a user: select finding/evidence, filter and navigate, update local Fix queue, trigger dirty-draft guard, and verify stale freshness blocks writes while evidence remains visible.

**Green:** move review-local state to the interaction owner without changing Pierre hooks.

**Refactor:** replace wide props with model/actions and delete duplicated state in `App`.

### Slice 6: flow extraction and regression proof

**Red:** existing route/profile/refresh/fixture tests are moved or expanded to prove each flow’s behavior through its visible route. Add stale-response tests when an old profile/session response completes after a newer selection.

**Green:** extract screen flows incrementally.

**Refactor:** shrink `App` and delete old screen-specific state/effects.

### Slice 7: package proof

Run the full static/test/browser/package gate. Then the dedicated `code-analysis.patchdesk-electron-tester` performs the live package check through CDP. It captures screenshots and proves saved PR #118, rail restoration, command palette, Overview/Diff, zero page-level horizontal overflow, and no console/page errors. It does not start a review or enter a GitHub write-confirmation flow.

## Risks and open questions

- **Question:** Does the current completed-review route require `App` to retain any state not captured by the proposed model/actions boundary? Resolve during Milestone 2’s behavior map, before choosing component file splits.
- **Question:** Which existing fixtures can become dedicated fixture-route modules without changing browser test URLs? Resolve from the browser tests before moving them.
- **Risk:** changing session-preparation ordering can accidentally allocate or mutate an Attempt. The preparation Service Module must not receive an execution/workflow dependency, and tests must prove read-only behavior.
- **Risk:** breaking development Session/local-storage data could produce confusing local state during development. The accepted posture is to delete/reset it rather than retain fallback paths. Document the required developer reset in the implementation handoff if it becomes necessary.
- **Risk:** renderer flow extraction can cause stale async updates. Keep request-generation/cancellation ownership inside the flow and test profile/session changes.
- **Risk:** a component-only test cannot prove packaged Electron geometry or bridge behavior. The dedicated packaged-Electron tester remains mandatory for live validation.

## Acceptance

The design is ready for implementation when the ExecPlan is accepted with this document as its typed handoff. Implementation begins with Milestone 1 only. Milestones 2 and 3 remain separate changes, and strict local-API command parsing remains deferred.
