# Plan 002: Simplify watchlist, auto-detect profiles, and show provider/model labels

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat 0b106de..HEAD -- src/adapters/pi src/renderer src/domain/workspace-profile.ts src/services/dashboard-service.ts src/services/dashboard-controller.ts src/services/profile-service.ts src/services/maintainer-inbox-service.ts src/main/local-api.ts src/main/desktop-bridge.ts src/adapters/storage/maintainer-inbox-cache-store.ts src/design`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `0b106de`, 2026-08-06
- **Spec**: `.agents/specs/2026-08-06-watchlist-profile-model/spec.md`

## Why this matters

The watchlist today requires manual `owner/repo` text input, manual path mapping, and an archive distinction that confuses users. The profile switcher is buried in Settings. Model labels don't show which provider is in use. This plan simplifies the watchlist to a tick-based Discovery surface, adds a profile switcher to the app shell, and shows `provider/model-code` labels in model selectors.

## Key design decision

`localPath` stays on `WatchedRepoConfig` but is **auto-populated by Discovery** (not user-editable). When you tick a repo from Discovery to add to the watchlist, its discovered local path is stored. Review preparation, worktree, and comparison services continue reading `localPath` from the repo config unchanged. Only `archived` is removed from the model.

## Current state

### WatchedRepoConfig (`src/domain/workspace-profile.ts:19-25`)

```ts
export type WatchedRepoConfig = {
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly localPath?: AbsolutePath;
  readonly archived?: boolean;
};
```

`archived` is being removed. `localPath` stays (auto-populated).

### DashboardService (`src/services/dashboard-service.ts:105-115`)

```ts
repos.push({
  repo,
  state:
    list.value.length === 0
      ? "no_open_prs"
      : repo.localPath === undefined
        ? "missing_local_path"
        : "ready",
});
```

The `missing_local_path` state becomes `ready` since `localPath` is always auto-populated from Discovery.

### MaintainerInboxService (`src/services/maintainer-inbox-service.ts:57-63`)

```ts
const active = profile.repos.filter((repo) => repo.archived !== true);
const archived = profile.repos
  .filter((repo) => repo.archived === true)
  .map((repo) => ({ repo, state: "archived" as const, complete: true }));
...
const repositories = [...archived, ...results.map((result) => result.repository)];
```

Archived filtering is removed. All repos are active.

### inbox-flow (`src/renderer/src/flows/inbox-flow.tsx:663-684`)

```ts
: outcome === "archived"
  ? "Archived repository. It is hidden from the active queue and can be restored in Settings."
...
) : outcome === "missing_local_path" || outcome === "archived" ? (
```

Both `"archived"` and `"missing_local_path"` outcome branches removed.

### Model catalog (`src/adapters/pi/pi-runtime-model-catalog.ts:104-106`)

```ts
.map((model) => ({
  id: canonicalModelId(`${model.provider}/${model.id}`),
  label: model.name,
}))
```

Label shows just the model name. Change to `provider/model-code`.

### Repo conventions

- Error handling: Result pattern (`src/domain/result.ts`). Match it.
- Component imports: `@/components/ui/<name>` alias, shadcn/Base UI primitives.
- Commit style: `feat: <summary>` or `feat(<scope>): <summary>`.
- Branch: `feat/<slug>`.

## Commands you will need

| Purpose   | Command              | Expected on success |
| --------- | -------------------- | ------------------- |
| Typecheck | `pnpm typecheck`     | exit 0, no errors   |
| Lint      | `pnpm lint`          | exit 0, no warnings |
| Tests     | `pnpm test -- --run` | all pass            |
| Build     | `pnpm build`         | exit 0              |

## Scope

**In scope:**

- `src/adapters/pi/pi-runtime-model-catalog.ts` — model label change (1 line)
- `src/domain/workspace-profile.ts` — remove `archived` from WatchedRepoConfig + valibot schema
- `src/services/profile-service.ts` — remove `setWatchedRepoArchived`
- `src/services/dashboard-controller.ts` — remove `archiveWatchlistRepo`
- `src/main/local-api.ts` — remove `PATCH /v1/watchlist/archive` route
- `src/main/desktop-bridge.ts` — remove archive route from allowlist
- `src/services/dashboard-service.ts` — remove `missing_local_path`; all repos with PRs become `ready`
- `src/services/maintainer-inbox-service.ts` — remove archived filtering (all repos active)
- `src/adapters/storage/maintainer-inbox-cache-store.ts` — remove `"archived"` from state picklist
- `src/renderer/src/renderer-contracts.ts` — remove `archived` validator
- `src/renderer/src/renderer-models.ts` — remove `archived` from Repo, remove `"archived"` from DashboardScreenState
- `src/renderer/src/flows/inbox-flow.tsx` — remove `"archived"` and `"missing_local_path"` outcome branches
- `src/renderer/src/app.tsx` — remove archived state mapping
- `src/renderer/src/components/watchlist-panel.tsx` — redesign to tick-based Discovery surface
- `src/renderer/src/flows/settings-flow.tsx` — rewire WatchlistPanel props
- `src/renderer/src/components/app-shell.tsx` — add profile switcher
- `src/design/mock-bridge.ts` — remove archived mocks
- `src/design/design-settings-overlay.tsx` — update watchlist preview
- Tests for each touched file

**Out of scope:**

- Custom saved inbox views.
- Owner filters logic.
- The Discovery API (`/v1/watchlist/suggestions`) stays as-is.
- Inbox refresh/caching mechanism.
- `localPath` field — stays on the model, auto-populated by Discovery.
- Review preparation / worktree / comparison services — they keep reading `localPath`.

## Steps

### Step 1: Model label — show `provider/model-code`

In `src/adapters/pi/pi-runtime-model-catalog.ts`, line 106:

```
label: model.name,
```

Change to:

```
label: `${model.provider}/${model.id}`,
```

**Verify**: `pnpm typecheck` → exit 0.
**Verify**: `pnpm test -- --run tests/adapters/pi-runtime-model-catalog.test.ts` → all pass.

### Step 2: Remove `archived` from the domain model

In `src/domain/workspace-profile.ts`:

- Remove `readonly archived?: boolean;` from `WatchedRepoConfig`.
- Remove `archived: v.optional(v.boolean()),` from `rawWatchedRepoSchema`.
- Remove any `archived` handling in `parseWatchedRepoConfig`.

**Verify**: `pnpm typecheck` → expect compilation errors pointing to call sites. Proceed to Step 3.

### Step 3: Fix all `archived` compilation errors

Remove archive-related code. For each file, verify the change compiles before moving on:

- `src/services/profile-service.ts` — remove `setWatchedRepoArchived` function and its export.
- `src/services/dashboard-controller.ts` — remove `archiveWatchlistRepo` method; remove `setWatchedRepoArchived` import.
- `src/main/local-api.ts` — remove `PATCH /v1/watchlist/archive` route handler and `archiveWatchlistRepo` usage.
- `src/main/desktop-bridge.ts` — remove `"PATCH /v1/watchlist/archive"` from the allowlist.
- `src/adapters/storage/maintainer-inbox-cache-store.ts` — remove `"archived"` from the state picklist (keep other values).
- `src/renderer/src/renderer-contracts.ts` — remove `archived: v.optional(v.boolean()),`.
- `src/renderer/src/renderer-models.ts` — remove `readonly archived?: boolean;` from `Repo`; remove `"archived"` from `DashboardScreenState`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Remove `missing_local_path` state

In `src/services/dashboard-service.ts`, change:

```ts
: repo.localPath === undefined
  ? "missing_local_path"
  : "ready",
```

To:

```ts
: "ready",
```

In `src/services/maintainer-inbox-service.ts`:

- Remove the archived filter block (lines 57-60). Keep only `const active = profile.repos;`.
- Remove the `const repositories = [...archived, ...]` merge; use `const repositories = results.map(...)`.

In `src/renderer/src/flows/inbox-flow.tsx`:

- Remove the `"archived"` outcome case (lines ~663-664).
- Remove `"missing_local_path"` from the condition at line ~684 (keep other states).
- Remove `"archived"` from the `DashboardScreenState` type if referenced.

In `src/renderer/src/app.tsx`:

- Remove the `archived` property spreading (lines ~624-626).
- Remove the `"archived"` check in the outcomes mapping (line ~654).

**Verify**: `pnpm typecheck` → exit 0.
**Verify**: `pnpm lint` → exit 0.

### Step 5: Simplify the Watchlist panel

Redesign `src/renderer/src/components/watchlist-panel.tsx`:

- Remove the `owner/repo` text input area.
- Remove the archive toggle, path editing UI, and remove confirmation dialog.
- Remove the `WatchlistActions` dropdown component.
- New UI: on mount, call Discovery (`GET /v1/watchlist/suggestions`). Show results grouped by workspace root (derive from `profile.workspaceRoots`). Each repo shows its auto-detected `localPath` (read-only). Checkbox next to each; watched repos pre-ticked. Toggling adds via `POST /v1/watchlist` or removes via `DELETE /v1/watchlist`.
- Accept `profile` directly instead of `dashboard`:

```ts
export type WatchlistPanelProps = {
  readonly profile: Profile;
  readonly onWorkspaceReload: () => Promise<void>;
};
```

**Verify**: `pnpm typecheck` → exit 0.
**Verify**: `pnpm lint` → exit 0.

### Step 6: Update Settings flow

In `src/renderer/src/flows/settings-flow.tsx`:

- Pass `profile` (derived from `dashboard?.profile` or the profile draft) to `WatchlistPanel` instead of `dashboard`.
- Remove the `onRepositoryRefresh` prop passthrough to `WatchlistPanel`.

**Verify**: `pnpm typecheck` → exit 0.
**Verify**: `pnpm lint` → exit 0.

### Step 7: Add profile switcher to app shell

In `src/renderer/src/components/app-shell.tsx`:

- Accept `profiles: ReadonlyArray<{ id: string; label: string }>` and `activeProfileId: string` and `onProfileSwitch: (id: string) => void` props.
- Add a `Select` dropdown in the toolbar showing the current profile label.
- On change, call `onProfileSwitch(id)`.

**Verify**: `pnpm typecheck` → exit 0.
**Verify**: `pnpm lint` → exit 0.

### Step 8: Update design files

In `src/design/mock-bridge.ts`:

- Remove the `archived: true` and `state: "archived"` mock entries.
- Remove the `repositoriesWithArchived` transform.

In `src/design/design-settings-overlay.tsx`:

- Remove `WatchlistActions` dropdown from preview.
- Update `WatchlistPreviewRow` to show read-only path (no edit UI).

**Verify**: `pnpm typecheck` → exit 0.

### Step 9: Update tests

Update tests for each changed file:

- `tests/adapters/pi-runtime-model-catalog.test.ts` — label assertions to `provider/model` format.
- `tests/renderer/settings-modal.ui.test.tsx` — update Watchlist assertions (remove archive, path editing, manual input).
- `tests/services/dashboard-service.test.ts` — remove `archived`/`missing_local_path` test cases.
- `tests/services/profile-service.test.ts` — remove `setWatchedRepoArchived` tests.
- `tests/browser/local-api-workbench.spec.ts` — remove any archive references.
- `tests/browser/accessibility.spec.ts` — update watchlist selectors.
- `tests/renderer/review-workbench-flow.ui.test.tsx` — remove `archived` references.

**Verify**: `pnpm test -- --run` → all pass.
**Verify**: `pnpm typecheck` → exit 0.
**Verify**: `pnpm lint` → exit 0.

### Step 10: Full build verification

**Verify**: `pnpm build` → exit 0.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test -- --run` exits 0; no test regressions
- [ ] `pnpm build` exits 0
- [ ] `grep -rn "archived" src/domain/workspace-profile.ts` returns no matches on WatchedRepoConfig
- [ ] `grep -rn "setWatchedRepoArchived\|archiveWatchlistRepo" src/` returns no matches (except test mocks or comments)
- [ ] `grep -rn "missing_local_path" src/services/dashboard-service.ts` returns no matches
- [ ] `grep -rn "label: model.name" src/adapters/pi/pi-runtime-model-catalog.ts` returns no matches
- [ ] No files outside the in-scope list are modified (`git status`)

## STOP conditions

Stop and report back (do not improvise) if:

- The code at "Current state" locations doesn't match the excerpts (codebase drifted).
- A step's verification fails twice after a reasonable fix attempt.
- Removing `archived` causes cascading failures in files not listed in scope that look intentional.
- A test file references archive behavior in a way that is not a straightforward removal.

## Maintenance notes

- `localPath` stays on `WatchedRepoConfig`; Discovery auto-populates it. If a repo is added directly (not via Discovery) later, `localPath` may be undefined and review launch will fail with a clear error.
- Profile switcher relies on `gh auth switch` or `gh auth status`. If gh CLI is absent, show a clear message.
- Model label change is backward-compatible: the `id` field is unchanged; only the display string changes.
