# Bucket changed files into a Scope gauge

> **Status: Accepted.** Companion to ADR 0036, which adds the Brief. The gauge
> is independent of it: it needs no model run and is always on.

"+1,240 / -318" tells a maintainer how big a pull request is, not what kind of
big. A thousand of those lines being a regenerated lockfile is a different
review from a thousand lines of `src/`, and the header count reads the same
either way.

## The decision

Patchdesk buckets every changed file by path and shows the result as one bar,
the **Scope gauge**. It is deterministic: the same patch always produces the
same gauge, with no model involved.

There are five buckets. The gauge draws them in the order `core, tests,
generated, docs, config`, and omits any bucket with no file in it. A path lands
in exactly one bucket, decided by rules evaluated in a different order —
`generated, tests, docs, config, core` — so a generated snapshot under `tests/`
reads as generated, and a Markdown file under `docs/` never reaches the config
rule. `core` is the fallthrough: whatever no other rule claimed.

The rules are path rules (`classifyChangedPath` in
`src/domain/change-scope.ts`): lockfile names, `.generated.` in a file name,
`__snapshots__` and `.snap`, test directory segments and `.test.`/`.spec.`,
`docs/` and `.md`, dotfiles and `.github/`, `scripts/`, `tsconfig*.json`, and
`*.config.*`. A `linguist-generated` list from `.gitattributes` and a
`DO NOT EDIT` banner are both honoured when the file contents happen to be
reachable; a unified patch carries no contents, so normally the path rules
decide alone.

Bucket colours are **categorical** (`--scope-*` in `styles.css`), never the
status hues. A large generated or docs share is a fact about the change, not a
warning, and must not read as one. The `generated` bucket is a diagonal hatch
rather than a sixth hue, so it reads as machine-written. A bucket that changed
at least one line keeps a two-percent sliver of the bar, so a one-line config
change beside a thousand-line lockfile does not vanish.

**Absent is not zero.** The gauge is computed from the patch the workbench
already reads. When those bytes are unreadable, `scope` is absent from the
projection and the gauge is not drawn — a gauge showing all-zero would claim
the pull request changed nothing.

On the Pull requests screen the gauge appears only on a row whose retained
Review session patch still matches the row's **current head**. This is a data
limit, not a preference. The inbox GraphQL queries return `additions`,
`deletions`, and `changedFiles` and no per-file list, so a row Patchdesk has
never opened has nothing to bucket. Drawing the gauge for every row needs a
per-pull-request `files(first: n) { path additions deletions }` read, with its
own paging and rate-limit budget; that is a separate decision. A session at an
older head is excluded for a different reason: its buckets would describe a
revision the row no longer shows.

## Consequences

- The gauge lives in three places: the workbench header chip, a Scope card in
  the Insights tab and in the Brief's side column, and the Changes cell of a
  Pull requests row.
- It went into the existing Changes cell rather than becoming a seventh inbox
  column, because a new column needs a header cell and a skeleton cell in
  `maintainer-inbox.tsx`, which the size ratchet has frozen.
- `MaintainerInboxRow` is persisted through a strict schema on both sides, so
  the new `scope` field had to be named in the cache row schema; without it,
  every cached inbox file would be rejected on the next read.
- The path rules are Patchdesk's, not the repository's. A project that keeps
  its tests somewhere unusual will see them bucketed as `core`. Per-repository
  rules are a later decision; the honest default is to classify what most
  repositories do and never to guess from file contents Patchdesk cannot read.
