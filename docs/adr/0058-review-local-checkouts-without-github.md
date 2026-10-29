# Review local Git checkouts without a GitHub connection

> **Status: Accepted** (2026-10-29, maintainer in chat, #817). Amends the
> origin rule of [ADR 0053](0053-choose-checkouts-instead-of-scanning-for-them.md)
> for local Reviews; its explicit picker and no-scan rules stand.
> [ADR 0051](0051-review-local-changes-for-the-coding-agent.md) stays
> authoritative for feedback, Apply, source identity and named-worktree paths.
> Terms in bold are defined in [the product glossary](../product-description/glossary.md).

## Problem

A checkout with two local branches and no remote cannot reach Local Review.
Setup reads `origin`, creates the workspace from an authenticated GitHub
account, then requires a watched repository
(`src/services/workspace-setup-service.ts`,
`src/renderer/src/flows/inbox-first-run.tsx`).

Profiles and local Review identities also require GitHub fields: a Local
Review stores `host`, `owner` and `repo`, and its ID is derived from them
(`src/domain/workspace-profile.ts`, `src/domain/ids.ts`, `src/domain/review.ts`).
Parsers recompute each ID from the stored triple and reject a mismatch, so
replacing the triple would invalidate every saved Review, session, draft,
Insight reference and app-managed Git ref.

## Decision

### Workspaces have an optional GitHub connection

```ts
type GitHubConnection =
  | { kind: "disconnected" }
  | { kind: "connected"; host: GitHubHost; account: GitHubLogin };
```

Connected means configured, not authenticated or online; authentication and
network readiness stay separate. Local work, labels and rules need no
connection and no fabricated GitHub identity. Live GitHub operations (polling,
pull request reads and preparation, images, reviews, writes, merge policy,
credentials) require the connected variant at their service boundary.
Disconnecting keeps saved pull request records and unresolved write journals.

### A local repository has a workspace-scoped ID

Each workspace stores a registration per local repository: a generated UUID,
`LocalRepositoryId`, a display name, the configured checkout root and the
canonical Git common directory. Registration runs Git from the chosen folder
(`--show-toplevel`, `--path-format=absolute --git-common-dir`) and resolves
symlinks. The common directory finds an existing registration within the
workspace; it is a locator, revalidated before reuse, not the identifier.
Registration neither scans folders nor contacts a host.

| Action                                            | Result                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Choose the same root, a subdirectory or a symlink | Same registration.                                                                                               |
| Choose a linked worktree                          | Same registration; the source keeps the selected checkout path.                                                  |
| Choose an independent clone with the same origin  | Different registration and Reviews. No deduplication by remote or commit.                                        |
| Add, remove or change remotes                     | Registration and Review IDs unchanged.                                                                           |
| Move the configured checkout                      | Marked missing. Explicit relocation keeps its ID and default-checkout Reviews after validation and confirmation. |
| Move a named linked worktree                      | The new path is a new source and Review, as ADR 0051 specifies. Old state is retained.                           |
| Choose the same checkout in another workspace     | Separate registration and stored state.                                                                          |

### One immutable identity key per registration

Each registration stores one `identityKey`:

- `{kind: "github", host, owner, repo}` for registrations created by the
  upgrade from a watched repository or a saved Local Review;
- `{kind: "local", localRepositoryId}` for registrations created afterwards.

The key never changes, including when remotes change. A stored Local Review
belongs to the registration whose key equals the repository identity it
already stores. No per-Review binding is stored.

GitHub keys pass their triple into today's ID derivation byte for byte, and
their records keep Review schema 2 and session schema 6, including Reviews and
sessions created later for that registration. Only local keys use new IDs,
`local__<uuid>__review-<sha256>` and `local__<uuid>__session-<sha256>`, with
Review schema 3 and session schema 7, which store `localRepositoryId` instead
of the triple. Parsers validate each schema's own derivation and never retry
invalid data under another interpretation.

### The upgrade writes only a registration catalog and the profile

Workspace schema 1 and catalog format 1 are introduced before normal profile
loading. The existing host and account become the connected variant. The
upgrade reads the profile's watched repositories and the stored Local Reviews:

- each watched repository with a checkout gets one registration keyed by its
  triple; a missing checkout gives a missing registration;
- each stored Local Review whose triple has no registration, including
  repositories removed from the watchlist, gets an unresolved registration
  from that triple;
- an unreadable Review stops activation rather than producing an incomplete
  inventory.

The catalog is validated and published atomically first; the profile is
replaced last and that replacement is the activation. A rerun reuses the IDs of
an already published catalog, so no upgrade journal is needed. Conflicting
inputs or a damaged catalog are refused rather than reallocated. No Review,
session, artifact, directory or Git ref is rewritten or moved. Running an older
build against the upgraded profile is not supported.

### Relocation and conflicting locators

Relocate checkout targets an existing missing registration. The candidate is
validated with Git, refused when it belongs to another registration, and the
affected Reviews are shown before confirmation. Relocation updates only the
registration locators and app-managed cache worktree bookkeeping.

Different historical triples can name one physical checkout after a remote
change. They stay separate registrations with separate Reviews; their shared
locator is marked unresolved and checkout-based operations need explicit
reconciliation. Reading by ID stays available. Namespaces are never merged and
never chosen by timestamp.

### Entry points

- First run offers **Open local checkout** and **Connect GitHub**. The local
  action opens the folder picker, validates Git, creates a disconnected
  workspace if needed, registers the checkout and opens the existing source
  dialog. Cancelling the picker creates nothing.
- Main navigation always offers Open local checkout, including when Pull
  requests cannot load. Visited Local Reviews are grouped by registration.
- When disconnected, Pull requests offers Connect GitHub instead of an
  authentication error, and no background polling or credential lookup runs.
- `patchdesk setup add-checkout --cwd <path>` registers a checkout and
  `patchdesk setup relocate-checkout --repository-id <id> --cwd <path> --confirm`
  relocates one. `add-repo` and `set-checkout` keep their GitHub watch
  behavior. Local setup does not require `gh`.
- MCP `review_local` and `list_local_reviews` resolve `cwd` through the same
  registration service. An unregistered checkout returns the setup
  instruction; listing never registers. `list_repositories` lists local IDs and
  checkout states, with GitHub associations only where they exist.

## Rejected alternatives

- Optional GitHub fields throughout the profile: allows half-configured states
  and leaves GitHub calls without a capability boundary.
- A synthetic triple, a parsed remote URL or a commit hash as local identity:
  invents a remote contract or merges independent clones.
- The root or common-directory path as the ID: relocation would change
  identity. Writing a UUID into `.git` writes to the user's repository and
  copies with the clone.
- Rekeying existing Reviews: rewrites sessions, drafts, Insight identity
  objects, hash-linked artifacts, progress, journals, cache paths and refs.
- Per-Review bindings: the stored repository identity already selects the
  registration.
- Attaching missing records by origin or matching commits, or searching the
  disk for a moved checkout: guesses continuity and reverses ADR 0053.
- Registering from a read-only MCP listing: changes that tool's authority.

## Consequences

- The local path no longer depends on GitHub setup, `gh` or a remote.
- Existing Review and session IDs, schemas, artifact addresses and refs stay
  unchanged; only new registrations use the new schemas.
- ADR 0053's `checkout_origin_mismatch` check applies to watched repository
  checkouts only.
- GitLab and Bitbucket pull requests, and commit, push or pull request actions,
  stay out of scope.
