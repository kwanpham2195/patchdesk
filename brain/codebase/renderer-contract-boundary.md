# Renderer contract boundary

The workbench projection is validated twice: the local API returns it, then the
renderer re-validates it with `parseWorkbenchResponse`
(`src/renderer/src/renderer-contracts.ts`). A 200 API response does NOT mean
the workbench will open.

## Failure signature

- `/v1/reviews/open` and `/v1/reviews/load` return 200 with a full projection.
- The UI silently stays on the inbox: no navigation, no alert, no console
  error. `openStoredReview` in `inbox-flow.tsx` returned early when
  `parseWorkbenchResponse` returned `undefined` (fixed Aug 2026: it now shows
  an openError alert).
- Only some PRs fail: the ones whose projection contains fields the strict
  schema rejects.

## Root cause class (Aug 2026 incident)

PRs with review-attached comments (typically PRs with inline review threads)
failed to open because the adapter emits `reviewId`/`canEdit`/`canDelete` on
timeline IssueComment entries, but the conversation refactor (084606b) reused
the strict `githubCommentSchema` for those entries, which rejected unknown
keys (`Expected never but received "reviewId"`).

Lesson: when domain types or adapters grow new fields, the renderer-contracts
schemas must be updated in the same change. The schema is the boundary; keep it
mirroring what the API actually sends.

## Diagnosis path

1. Call `POST /v1/reviews/open` or `/v1/reviews/load` from the renderer context
   (`window.patchdesk.request`) and confirm it returns 200.
2. Run `parseWorkbenchResponse` on that body to isolate the failing field:
   - In the live page: `await import('/src/renderer-contracts.ts?v=' + Date.now())`
     then call it. The cache-busting query is required after HMR.
   - Add a temporary `console.log(parsed.issues)` inside `parseWorkbenchResponse`
     to see the exact path (valibot issues include `path`, `expected`, `received`).
3. Check the renderer console for `[contracts] parseWorkbenchResponse FAILED`.
4. Compare the failing field against the domain type in
   `src/domain/github-context.ts`; the schema and domain type must agree.

## Boundary trap: which layer is rejecting?

- Stored snapshots (`ReviewRemoteStore`) are content-addressed and hash-checked:
  a stored snapshot that parses to a different shape fails the hash check
  anyway. Loosening storage schemas (`strictObject` → `object`) does not fix
  renderer contract rejections and makes diagnostics worse (silent key
  stripping). Revert such changes; fix the renderer contract instead.
- The renderer contract is the last validation before state reaches React.
  Prefer adding an explicit optional field over loosening (`v.object`) — the
  schema also guards against smuggled secrets (`prompt`, `errorDetail`,
  paths) that strict rejection protects.
