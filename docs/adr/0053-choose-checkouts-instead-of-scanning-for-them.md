# Choose checkouts instead of scanning for them

> **Status: Accepted** (2026-09-29, maintainer on #641). Supersedes the
> workspace-root discovery that ADR 0031 kept ("`discoverWorkspaceRepos` ...
> stays"). Amends ADR 0050's rule that a local source needs a profile
> repository with a `localPath`: how that path is set. Terms in bold are
> defined in [the product glossary](../product-description/glossary.md).

Patchdesk found local checkouts by scanning folders. A first-run profile
saved the home directory as its one workspace root, and discovery ran
`find <root> -maxdepth 4 -type d -name .git` on every root. From `~` that walks
`~/Music`, `~/Pictures` with the Photos library, `~/Movies`, `~/Desktop`,
`~/Documents`, `~/Downloads`, and `~/Library`. macOS asks the user for access
to each protected folder the walk enters, so a code review app opened by
asking for the Apple Music library. The scan also cost up to 5 seconds per
root on every Settings visit. It fed only two things: watchlist suggestions
and each suggested repository's `localPath`.

## The decision

- **No scan.** Patchdesk never searches the disk for checkouts. The workspace
  root setting, the first-run home-directory root, discovery
  (`WorkspaceOriginFinder`, `DashboardService.discoverWorkspaceRepos`,
  `GET /v1/watchlist/suggestions`), and the Settings folder rows are removed
  rather than pruned. Pruning protected folders would still read `~` and
  would still need a list of folders macOS protects.
- **Watch by name.** A watched repository is added as `owner/repo` on the
  workspace's host. `PUT /v1/watchlist` carries identity only.
- **Choose the checkout.** A repository's `localPath` is set only by
  `PUT /v1/watchlist/checkout` with a folder the maintainer picked in the
  main-process folder picker. The main process accepts it when
  `git rev-parse --show-toplevel` finds a checkout around it and that
  checkout's `remote.origin.url` names the repository, and it stores the
  top-level with symlinks resolved. Other folders are refused
  `checkout_not_a_repository` or `checkout_origin_mismatch`.
- **Where the picker appears.** On each watched repository's row in the
  Repositories card, which Settings → Workspace and first-run setup share,
  and on the Local review button for a repository with no checkout, which
  asks for it before offering sources. Both write the same `localPath`, so a
  checkout chosen once is reused.
- **Old profiles.** `workspaceRoots` shipped in v0.0.12 profiles. The profile
  parser still accepts the key and ignores it. Every save writes
  `workspaceRoots: []`, because v0.0.12 refuses a profile without the key and
  then opens no profile at all, and the maintainer runs a release build beside
  the dev app on the same config folder. The write goes once a tagged release
  contains #641. Old values are not migrated into checkouts.

## Consequences

- First launch reads no folder and raises no macOS privacy prompt. The only
  folder Patchdesk reads is one the maintainer picked, and a pick inside a
  protected folder is the user's own request.
- Adding a watched repository takes typing its name. A mistyped or
  inaccessible repository is watched anyway, and the first listing read
  reports it.
- A repository can be watched with no checkout. Pull requests still list;
  a local Review asks for the checkout first.
- A moved checkout is fixed with Choose checkout instead of re-adding a
  folder and re-ticking the repository. The `checkout_missing` sentences in the
  renderer and in the MCP refusal say so.
