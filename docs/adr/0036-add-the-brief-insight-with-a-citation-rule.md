# Add the Brief Insight with a citation rule

> **Status: Accepted.** Superseded in part by ADR 0040 (Goal, Assumptions,
> Description vs diff, and the uncited-rejection rule); the citation
> manifest and the hunk-alias rule remain. Adds a third Insight type beside
> Analysis and Walkthrough. It inherits ADR 0012 (each Insight type runs on
> its own, and an outdated result stays readable), ADR 0013 (a model run is
> bounded and never authoritative), and ADR 0018 (one throwaway Flue child
> per run, no new model-visible capability). Terms in bold are defined in
> `CONTEXT.md`.

A maintainer opening a pull request has two Insights. **Analysis** returns
Findings: concerns, each anchored to a diff location. **Walkthrough** returns a
guided tour: chapters that read the patch in order. Neither answers the first
question a reviewer asks, which is what this change is for and where to start
reading it.

Both existing types also share one weakness. Their prose is checked for shape,
not for support. A Walkthrough section is accepted when the prose mentions the
hunk path it cites (`src/domain/narrative-walkthrough.ts`); an Analysis Finding
is accepted when its evidence maps to a diff line. Neither rule reaches the
sentences a reviewer actually reads first. So a model can write "this refactor
keeps the public API unchanged" with no evidence at all, and Patchdesk will
show it in the same typeface as a claim it verified.

A concrete case. A pull request removes `parseInsightRunId` and adds
`parseReviewSessionId`. A plausible model sentence is "the change is internal;
no caller outside this module is affected." That sentence is a count and a
claim about code the model never read: the patch shows only the changed lines,
and the model has no way to see an unchanged caller. Today nothing stops it
being displayed.

## The decision

Patchdesk adds a third Insight type, the **Brief**: a short, cited answer to
"what is this change for, and where do I start?" It has no verdict and no
findings. Those stay with Analysis.

### Five blocks, in one fixed order

A Brief always draws its blocks in the same order, so a maintainer reading a
second Brief knows where to look.

1. **Goal** — two to four sentences, coarse to granular, each carrying its
   citations. **Assumptions** follow directly under it.
2. **Description vs diff** — two columns: what the pull request description
   claims that the diff does not support, and what the diff changes that the
   description never mentions.
3. **Shape** — a deterministic file tree of what changed, the model's one-line
   note per file, and the single hunk whose signature explains the rest.
4. **Reach** — what depends on the changed code, one hop out, by text match.
5. **Start here** — one sentence of reading advice, then the first three to
   five files in the order to read them, with a control that opens or generates
   the Walkthrough.

Start here is drawn as a card in the reader's side column, above the **Scope
gauge** (ADR 0037) and a Provenance card that names the revision, the
generation time, the provider and model, and the citation counts. The order
above is the order of the blocks themselves, not of the two page columns.

A block whose evidence does not exist is absent rather than empty. A pull
request with no description has no Description vs diff block at all.

### Every model sentence cites a manifest alias

Before the run, Patchdesk builds one **citation manifest** from evidence it
owns and hands it to the model as `alias | kind | label` lines
(`briefManifest` in `src/domain/brief.ts`). The alias namespace is prefixed, so
a citation names its evidence kind before anything looks it up:

- `h1`, `h2`, … one diff hunk of the session's stored patch.
- `d1`, `d2`, … one paragraph of the pull request description.
- `c1`, `c2`, … one commit of the represented revision, by short SHA and
  subject.

When the result comes back, `normalizeBrief` resolves every alias against that
manifest. The rule is graded rather than binary:

- A Goal sentence keeps only the citations that resolve.
- A Goal sentence left with none is **demoted to an Assumption** — not deleted.
  A Brief may state something it cannot cite, but never as a Goal. The reader
  labels a demoted line "Assumption · uncited claim".
- A Brief whose every Goal sentence is demoted is **rejected outright**
  (`InvalidBrief`, reason `uncited`). Nothing is retained.
- Description vs diff adds a kind requirement, because each column is about a
  different source: a claimed item must resolve at least one `d*` alias, an
  undescribed item at least one `h*`. An item that does not is dropped.
- A Shape note whose path is not a file this patch changed is dropped, and so
  is a Start here order that names no changed file.

Every drop is counted. A Brief with no drops is stored `verified`; a Brief with
any is stored `partially_verified`, and the reader says which.

**The model never writes a number.** The prompt says so
(`insightOutputGuidance("brief")`, "Write no numbers and no counts. Patchdesk
produces every count from a tool"), and the schema gives it nowhere to put one.
Every count in a Brief — changed lines per file, callers, files per bucket — is
produced by Patchdesk from the patch or from a command.

### Reach is computed by Patchdesk, not by the model

Reach is the block that most obviously wants a search tool, and it does not get
one.

Neither provider can search the worktree today, and the check was run rather
than assumed. A Pi/Flue child gets four bounded inspector tools, and its
`search_files` is an in-memory substring scan over the **changed-file
snapshots** only (`src/services/review-inspector.ts`,
`model-review-runner.ts`) — it cannot see an unchanged caller, which is the
entire question Reach asks. A Codex child gets no Patchdesk tools at all; it
uses Codex's own read-only sandbox, whose escalation gate `isReadOnlyCommand`
(`src/adapters/codex/codex-app-server-client.ts`) declines every `rg`, `grep`,
and `git grep` shape, because a search pattern is not a path.

Giving the child a real search tool was rejected. ADR 0018 states that adding a
new model-visible capability changes the isolation and authority boundary and
requires its own decision and threat review. That is a correct rule and this
feature is not a reason to bend it.

Parsing the repository was rejected too. ADR 0033 removed Call Flow along with
its `tree-sitter` and `calldiff` dependencies. A call graph would bring them
straight back, for a block that is one hop deep.

So the work splits. The model proposes **names only** — up to twelve exported
functions, types, or constants whose meaning this patch changes, spelled
exactly as the patch spells them. Patchdesk then:

1. Keeps a proposed name only when it is a plausible identifier **and** appears
   as a whole word on a line this patch added or removed
   (`candidateReachSymbols`). A model naming something the diff never touched
   is naming something it did not read. When nothing survives, the patch's own
   `export`-shaped declarations stand in.
2. Verifies the represented worktree is the app-owned one for this session, by
   `realpath` comparison and by `git rev-parse HEAD`, and then names
   `<headSha>` as the search revision — so the tree that is counted is the
   immutable one even if the worktree moves between the check and the search.
3. Runs `git grep --fixed-strings --word-regexp --count -e <name> <headSha>` in
   that worktree through the existing `CommandRunner`
   (`src/services/brief-reach-service.ts`). One `git grep` over a repository
   this size takes about 0.1 s; the block's whole budget is 15 s.

The counts are **file counts, not call counts**, and the block is labelled
"text match" and never "call graph". `method: "text_match"` and `hop: 1` are
stored beside the numbers so the reader states how they were made rather than
inferring it.

One subtlety is load-bearing. `git grep` exits 1 with empty stdout **and empty
stderr** when a pattern matches nothing, which `CommandRunner` reports as
`CommandFailed` with an empty `stderr` — by tag alone, indistinguishable from a
real failure. `runGit` therefore reads exactly that shape as a count of zero.
Without the rule, the first symbol nobody references would have made the whole
block unavailable.

The search never fails a Brief. An unverifiable worktree, a moved head, a
failed search, or an exhausted budget is stored as `reachUnavailable` in the
block's place, and the reader says in one line why there is no Reach.

### The maintainer chooses the provider and the model

A Brief runs from the same run dialog as Analysis and Walkthrough, with the
same model picker, and records the same provenance (provider and model) on the
retained artifact. There is no hard-wired model, and no auto-run: a Brief
starts when the maintainer asks for one. The Scope gauge beside it is
deterministic and always on, because it costs no run.

## Consequences

- A review gains a third retained artifact, `insights/brief.json`, under the
  same retention rule as the other two (ADR 0003, amended for the Brief).
- Two new routes, `POST /v1/reviews/insights/brief/run` and
  `.../brief/cancel`, listed in the desktop bridge allowlist as well as
  registered.
- The Flue child gains a Brief variant (`createBriefAgent`) that mounts only
  the result-submission tool — no skill, no inspector tools, no sandbox, no
  MCP. It is the narrowest of the three children, so ADR 0018's isolation
  boundary is unchanged.
- The Brief's evidence travels **on the invocation** rather than as a prepared
  artifact the child reads. The description and commit subjects come from the
  represented GitHub snapshot, not from an app-owned file, so the Brief
  production schema carries a bounded `evidence` field (256 KB, 500 commits)
  where the other two carry paths only. The prompt-text invariant is unchanged:
  the schema has no `prompt` key, and the child still builds its own prompt.
- Missing evidence is not a failure. A pull request with no description and no
  readable commits yields a manifest of hunks alone, and a Brief citing only
  hunks is still a cited Brief.
- A retained Brief stores its **resolved** citation labels, so reading it back
  needs no patch bytes — unlike a Walkthrough, which is renormalized against
  its session patch on every read. `parseStoredBrief` is a plain schema parse.
- The size ratchet drove the module layout, not taste. New files on this branch
  are held to 500 lines, so the Brief is five domain modules (`brief.ts`,
  `stored-brief.ts`, `brief-ownership.ts`, `brief-reach.ts`,
  `brief-start-here.ts`) and its reader is two renderer modules. The frozen
  1,000-line files paid for their new fields by deduplicating what they already
  repeated.
- The Shape block's code is named `ownership`, not `shape`. The `anti-slop`
  lint rule `no-shape-in-symbol-names` rejects that substring in any
  identifier, including an object key, so the wire key, the stored key, and
  every symbol are named for the question the block answers. The heading a
  reviewer reads is still "Shape"; a string literal is not a symbol.
- Insights are still enumerated in two places the Brief has not reached: the
  Insights overview lists Analysis and Walkthrough cards only, and
  `initialDetail` accepts only `analysis` and `walkthrough`, so a Brief cannot
  yet be deep-linked or restored when the workbench opens.
- The Brief was verified by the automated suites and by one packaged-child
  round trip, not in the running app. No screenshot of any Brief block exists
  yet.
