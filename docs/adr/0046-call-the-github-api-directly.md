# Call the GitHub API directly

> **Status: Accepted.** Issue #276. Amends ADR 0021: which account a call runs as is
> unchanged, only how the credential is carried. Lifts the deferral recorded in
> ADR 0023 — response headers become readable. Changes the fixture contract ADR
> 0024 depends on. ADR 0026's canonical patch hash and ADR 0035's write
> reconciliation are not weakened; both constrain how the cutover is sequenced.

Every GitHub read and write Patchdesk makes today is a `gh api` child process.
That costs a process launch and a TLS handshake per call, and the app makes a
lot of calls.

Measured on this machine against `api.github.com`:

- `gh api rate_limit`: 760 ms per call.
- The same request as `curl` with a bearer token and a fresh TLS handshake:
  520 ms.
- The same request as a node `fetch` on a reused connection: 430 ms per call.

The difference decomposes. About 240 ms per call is process startup — fork,
exec, Go runtime init, config read. About 90 ms is a TLS handshake a kept-alive
connection would not repeat. Neither buys anything.

The app's own spawn telemetry at commit `66581aac` says what that costs in
aggregate. One `detect-updates` cycle is **29 spawns, 23.4 s of subprocess
time, and 5.8 s of wall time**, and it touches **14 distinct GitHub
resources**. Fifteen of the 29 spawns — 52 percent — re-fetch something the
same cycle already holds:

| endpoint | spawns |
| --- | --- |
| `pulls/:n` | 6 |
| `GET user` | 3 |
| `branches/:branch/protection` | 3 |
| `pulls/:n/reviews` | 3 |
| `pulls/:n/comments` | 2 |
| `issues/:n/comments` | 2 |
| `graphql PullRequestThreads` | 2 |
| `collaborators/:user/permission` | 2 |

Mean cost per spawn is 807 ms, so the ~330 ms of transport overhead is about
41 percent of every call. Opening a Review is 45 spawns and 40 s of subprocess
time. Startup alone runs `gh auth status` four times at 1.6 s each.

The duplication is a separate defect with a separate fix, and removing it does
not need this decision. What this decision addresses is the other 59 percent's
companion: the fixed toll every remaining call pays.

**What makes it available.** `github-credentials.ts:36-65` already runs
`gh auth token --hostname <host> --user <account>`, caches the raw bearer token
in memory for five minutes, and hands it to each `gh api` child through
`GH_TOKEN` or `GH_ENTERPRISE_TOKEN` (`:76-85`). Patchdesk already holds the
token. It is spending 240 ms per call to launch a process whose only privileged
input it supplied itself. There is also precedent for sending it: the pull
request image path pulls the token out of `environmentFor` and issues a bare
`fetch` with it.

## The decision

The main process calls the GitHub API directly over HTTPS. `gh api` goes away.

`gh` keeps only the jobs that need its credential store, and nothing else:

- `gh auth token` — read the profile account's stored credential, as today.
- `gh auth status` — report whether an account is usable.
- `gh --version` — the installed-and-supported check.
- `gh auth git-credential` — Git's credential helper for the worktree fetches.

`command-runner.ts` stays. Its scope narrows to `git` and `gh auth`.

**Host URL prefixing becomes Patchdesk's own code.** `gh` derived the API base
from the host; the HTTP client now does:

- `github.com` → `api.github.com`
- `*.ghe.com` → `api.<host>`
- GitHub Enterprise Server → `<host>/api/v3` for REST, `<host>/api/graphql`
  for GraphQL

ADR 0021's rule is unchanged: every call still runs as the account the
workspace profile names, resolved through the same `gh auth token` read and the
same per-account cache. Only the carrier changes, from a child process
environment variable to a request header in this process.

## Shadow window

> **Completed history.** The shadow finished its job on 2026-09-19: twenty read
> labels were cut over on its counts, and a live write check that day shadowed
> the lookups inside the write flows with no divergence. T4 deleted the
> machinery — `transport-shadow.ts`, `PATCHDESK_TRANSPORT_SHADOW`, and the
> report's `--shadow` mode. The text below records how the evidence was
> gathered; none of it can be run today.

No call site moves onto the HTTP client on the strength of a fixture. A launch
with `PATCHDESK_TRANSPORT_SHADOW=1` runs the client concurrently with `gh` for
every read and compares the two answers — byte equality for text, deep equality
for parsed JSON, tag equality for a failure. **`gh`'s answer is always the one
served**, the shadow is never awaited on the serving path, and every failure of
it is swallowed, so switching it on cannot change what a read returns or when.
It doubles read traffic against the same 5000-per-hour limit, which is why it
is off by default.

A read `gh` projected with `jq` was recorded as skipped rather than compared:
`gh` answered the projected value and the client the whole body, so the two
were not comparable. There was one such read, `GET user`, and it now parses
the login out of the whole body on both transports; `jq` is gone from
`GitHubRestRequest` with its last caller, and so is the skip.

Each comparison writes one `transport-shadow` log entry carrying the normalized
endpoint label, the outcome, and where the two first differed — never a
response body, a token, or a header value.
`node scripts/gh-spawn-report.mjs --shadow [--since <iso>] [--until <iso>]`
sums those entries into one row per label, so a label is cut over on a count of
clean reads rather than on a judgement (issue #292).

## Cutover record

**2026-09-19, T4: every request goes over HTTPS.** `GhRequestRunner` holds one
transport and makes no routing decision. `httpServedReadLabels`,
`httpServedWriteLabels`, `transportRouteFor`, `isReadRequest`,
`PATCHDESK_GITHUB_TRANSPORT`, and `PATCHDESK_GITHUB_WRITES` are all deleted, and
`gh api` has no call site left. There is no fallback in either direction: an
HTTP failure is the call's failure, classified from the response status rather
than from stderr. Rolling back is a git revert of this change, not a switch.

Nine labels moved at T4 without a comparison window of their own, because no
window running the app could reach them. Three of them were compared once
during the live write check, which ran the shadow over the lookups inside the
write flows: `ConfirmCreatedCommentThread` 2 of 2 clean, `PendingReviewThreads`
7 of 7 clean, `ReviewThreadTarget` 3 of 3 clean, no divergence. The other six
moved on request-shape equality alone: `api GET
repos/:owner/:repo/contents/:path`, `api GET repos/:owner/:repo/pulls`,
`api graphql MaintainerInbox`, `api graphql WatchedPullRequests`,
`api graphql ReviewThreadComments`, and `api graphql ReviewCommentTarget`. None
of the nine used a `gh api` flag the client does not reproduce: each is a plain
REST GET or a GraphQL document with the same `-f`/`-F` variable typing every
cut-over query already uses, so no `--jq`, `--paginate`, `--slurp`, or `Accept`
header changed shape.

The twenty read labels below were cut over first, at T1a, T1b, and T2, each on
a count of clean shadow comparisons rather than on a judgement:

    api GET repos/:owner/:repo/commits/:sha/check-runs
    api GET repos/:owner/:repo/commits/:sha/status
    api GET repos/:owner/:repo/collaborators/:user/permission
    api GET repos/:owner/:repo/branches/:branch/protection
    api GET repos/:owner/:repo/branches/:branch/protection/required_status_checks
    api GET repos/:owner/:repo/rules/branches/:branch
    api GET repos/:owner/:repo/issues/:n/comments
    api GET user
    api GET repos/:owner/:repo/pulls/:n
    api GET repos/:owner/:repo/compare/:range
    api GET repos/:owner/:repo/pulls/:n/reviews
    api GET repos/:owner/:repo/pulls/:n/comments
    api GET repos/:owner/:repo/pulls/:n/commits
    api graphql MergePolicy
    api graphql PullRequestThreads
    api graphql MaintainerInboxSearch
    api graphql AssignableUsers
    api graphql PullRequestReviewers
    api graphql RepositoryBranches
    api graphql RepositoryLabels

`pulls/:n/commits` is the one that paginates inside a single call: the client
follows `Link` to the last page and answers the one array of page bodies
`--paginate --slurp` answered with, which is the shape the 250-entry
truncation guard reads. The two GraphQL reads that follow a cursor do it as
separate requests the adapter drives, each of which is routed here on its own.

**The maintainer's typed text is a variable, and its type is part of the
comparison.** The assignee and branch pickers send what was typed as a GraphQL
variable, so the assignee search keeps gh's `-F` inference and the branch
search keeps `-f`'s plain String. Two consequences carry over unchanged rather
than being fixed by the transport: an all-digit assignee search still reaches
`$search: String` as an Int (issue #279), and a leading `@`, which gh's `-F`
read as a filename to take the value from, now reaches GitHub as the text.

**A GraphQL label was not enough to be served.** Queries and mutations share
one endpoint and a mutation is labelled by its root field, so a mutation could
carry an allowlisted label. While the allowlists existed, the routing served a
GraphQL request only when `isQueryDocument` in `github-request.ts` also read
the document as a query. T4 removed the decision; `isQueryDocument` no longer
gates anything.

**A 200 carrying `errors` is a failure on both transports.** `gh api graphql`
exited nonzero whenever the response held a non-empty `errors` array, partial
`data` beside it included, so every caller has only ever seen that as a
failure. The client classifies the same body through the same
`classifyGraphqlErrorBody`, which now maps `RATE_LIMITED` structurally: gh
reached `CommandRateLimited` through the rate-limit phrase in its own stderr,
and the HTTP transport has no stderr to read.

Why no shadow window reached the nine labels T4 moved. Two are REST reads
nothing outside the gateway port calls:

- `api GET repos/:owner/:repo/contents/:path` — `getFileContents` has no
  caller in `src/main`, `src/services`, or the renderer.
- `api GET repos/:owner/:repo/pulls` — the open pull request list;
  `listOpenPullRequests` has no caller there either.

Seven are GraphQL queries, each unreachable for a reason of its own:

- `api graphql MaintainerInbox` — the unfiltered inbox listing. The inbox
  service reads `MaintainerInboxSearch` instead, and
  `listMaintainerPullRequests` has no caller outside the port.
- `api graphql WatchedPullRequests` — the watched-pull-request poll, which
  reads nothing while the profile watches none and answers from the cached
  rate limit while a host's budget is spent.
- `api graphql PendingReviewThreads` — read only while the maintainer holds a
  pending review of their own.
- `api graphql ReviewThreadComments` — the continuation page of one thread,
  read only when a thread carries more comments than the first page held.
- `api graphql ReviewThreadTarget` — runs inside the reply and resolve write
  flows.
- `api graphql ReviewCommentTarget` — runs inside the comment edit and delete
  write flows.
- `api graphql ConfirmCreatedCommentThread` — runs inside the thread-create
  write flow.

Through T2 every mutation stayed on `gh` whatever its label: a mutation is
labelled by its root field, so `isQueryDocument` rather than the allowlist is
what kept it off the HTTPS path. T3 gave the writes an allowlist of their own,
below, and T4 deleted both.

**The compare read is hashed, so its bytes are the contract.** `Response.text()`
and a default `TextDecoder` both strip a leading UTF-8 byte order mark; gh
wrote its stdout through Node's utf8 stream decoder, which keeps it. The
client therefore decodes the response stream with `ignoreBOM`, so the bytes
`canonicalPatchHash` covers are the bytes GitHub served (ADR 0026). CRLF
endings, non-ASCII text, and a missing trailing newline already survived
unchanged.

T2 extended the list; T3 added a second one for the writes, below; T4 deleted
both together with the last `gh api` argv. The gh-specific failure
classification named under Consequences is the remaining step.

### The writes, and why their proof is different

A read was proven by running both transports on the same call and comparing.
A write cannot be sent twice, so there is no shadow and no comparison window.
Its proof is three other things: request-shape equality against the `gh api`
argv and stdin the same call encoded, a failure-classification table driven
from real HTTP responses and real socket conditions on a loopback server, and
one manual live check, recorded below, which the maintainer ran before the
default flipped.

The twenty-three write labels are listed here because they are what that check
exercised. While `httpServedWriteLabels` existed, a write label named **the
method GitHub receives**, not the one in the argv: `gh api --input -` with no
`--method` posts, so a body-carrying request normalized to a GET label that
would otherwise have collided with a read's. `restMethodFor` still holds that
rule, because the client sends the same verb from it.

Nine REST writes. All nine carry the default `Accept:
application/vnd.github+json`, and only those with a body carry a
`Content-Type`. The two bodyless DELETEs are also the two writes whose answer
the call site reads as text rather than JSON.

| label | call site | body |
| --- | --- | --- |
| `POST repos/:owner/:repo/pulls/:n/reviews` | `createPendingReview`, `startPendingReviewWithThread`, `createDirectSummaryReview` | `commit_id`, and `body`/`comments`/`event` per caller |
| `POST repos/:owner/:repo/pulls/:n/reviews/:n/events` | `submitPendingReview` | `event`, `body` |
| `PUT repos/:owner/:repo/pulls/:n/reviews/:n/dismissals` | `dismissReview` | `message` |
| `DELETE repos/:owner/:repo/pulls/:n/reviews/:n` | `discardPendingReview` | none |
| `PUT repos/:owner/:repo/pulls/:n/merge` | `mergePullRequest` | `sha`, `merge_method` |
| `POST repos/:owner/:repo/pulls/:n/comments` | `createInlineComment` | `body`, `commit_id`, the anchor coordinates |
| `PATCH repos/:owner/:repo/pulls/comments/:n` | `updateReviewComment` | `body` |
| `DELETE repos/:owner/:repo/pulls/comments/:n` | `deleteReviewComment` | none |
| `DELETE repos/:owner/:repo/pulls/:n/requested_reviewers` | `removeRequestedReviewers` | `reviewers` |

Fourteen mutations. The kind column is the flag gh sent each variable with:
`-F` inferred a type from the text, `-f` always sent a String, and `name[]=`
repeated per element is a real GraphQL list.

| label | variables |
| --- | --- |
| `addLabelsToLabelable` | `labelableId` -F, `labelIds` list |
| `removeLabelsFromLabelable` | `labelableId` -F, `labelIds` list |
| `addAssigneesToAssignable` | `assignableId` -F, `assigneeIds` list |
| `removeAssigneesFromAssignable` | `assignableId` -F, `assigneeIds` list |
| `requestReviews` | `pullRequestId` -F, `userIds` list |
| `updatePullRequest` | `pullRequestId` -F, `baseRefName` -f |
| `markPullRequestReadyForReview` | `pullRequestId` -F |
| `convertPullRequestToDraft` | `pullRequestId` -F |
| `addPullRequestReviewThread` | `reviewId` -F, `path` -F, `line` -F, `body` -f |
| `addPullRequestReviewThreadReply` | `threadId` -F, `body` -f |
| `resolveReviewThread` | `threadId` -F |
| `unresolveReviewThread` | `threadId` -F |
| `updatePullRequestReviewComment` | `commentId` -F, `body` -f |
| `deletePullRequestReviewComment` | `commentId` -F |

Resolve and unresolve, ready-for-review and convert-to-draft, and the two
diff sides of `addPullRequestReviewThread` each pick a GraphQL field or an
enum in the document rather than a variable, so the document is what differs
and, for the first two pairs, the label too.

**The write switch was temporary, and separate from the rollback.**
`PATCHDESK_GITHUB_WRITES=http`, read once in `githubTransports()` beside the
other two, served those labels over HTTPS while the default was still `gh`. It
was a per-launch opt-in because a write has no shadow. The live check below
passed on 2026-09-19 and T4 deleted the variable with both allowlists.

**Three things the client had to be taught, found by writing the shape tests.**

- *A body with no method is a POST.* `restMethodFor` in `github-request.ts` is
  the one place that rule lives, read by the client's `method`. No current call
  site relies on it — every write names its method — but a request that did
  would have been sent as a GET.
- *The response body mode belongs to the caller, not to the media type.*
  `ghText` and `ghJson` are what `runText` and `runJson` were, so the client
  gained `restText`, which hands over the response bytes unparsed, while
  `rest` always parses. The media type no longer decides. This is what
  `discardPendingReview` needs: gh handed it any exit-0 stdout as the receipt,
  and GitHub answers that endpoint 200 with the deleted review as JSON, which
  the previous content-type sniffing turned into a parsed object the text
  caller then failed on. It also restores `CommandInvalidJson` for a JSON
  caller handed an empty 204 or a non-JSON 200, which is what `runJson` did
  with the same stdout.
- *`X-GitHub-Api-Version`.* The client sends `2022-11-28` on every REST call.
  gh 2.100.0 carries the same header name and the same value in its own
  binary, so this matches rather than adds.

**No write is retried, and Chromium's resend is an accepted risk.** Neither the
client nor `writeFailure` retries: a failed write is the call's failure, and
there is no fallback to `gh`. Node's `fetch` does not retry either — undici's
retry is opt-in through `RetryAgent`/`RetryHandler` and the default dispatcher
has none. Electron's `net.fetch` is the one that resends. Chromium's
`HttpNetworkTransaction::ShouldResendRequest` reads

    bool connection_is_proven = stream_->IsConnectionReused();
    bool has_received_headers = GetResponseHeaders() != nullptr;
    return connection_is_proven && !has_received_headers;

and the HTTP method is not consulted anywhere in that decision. On 2026-09-19
this was accepted rather than closed: writes stay on `net.fetch`, and a
transparent resend of a POST is a risk this app carries.

**The window is wider than an idle reused socket.** `api.github.com` speaks
HTTP/2, and `SpdySession::IsReused()` answers true once any frame has arrived
on the session. The server's opening `SETTINGS` frame is such a frame, and it
arrives before the first request is sent, so `connection_is_proven` is true for
every write rather than only for a write on a socket the app already used. A
write that fails with `ERR_CONNECTION_RESET`, `ERR_CONNECTION_CLOSED`,
`ERR_EMPTY_RESPONSE`, or `ERR_SOCKET_NOT_CONNECTED` before any response header
arrives is resent by the network stack, invisibly to this app. Both function
bodies were read from Chromium `main`; neither was checked against the revision
Electron 43 pins.

`gh` was not free of this either, but its rule was narrower. Go's
`persistConn.shouldRetryRequest` replays a non-idempotent request on a reused
connection only for `nothingWrittenError` — nothing of the request reached the
socket — and only when the body can be rewound; every other error goes through
`Request.isReplayable`, which a POST without an `Idempotency-Key` header fails.
Chromium asks neither question, and it counts a fresh HTTP/2 session as proven,
so the window in which a write can be sent twice is wider over `net.fetch` than
it was over `gh`.

**Most resends end correctly.** In the dominant case the server closed the
connection without processing the request, so the resend is the only delivery
and there is no duplicate. When the first request did land, a resent submit,
dismiss, merge, discard, or delete acts on something the first one already
consumed, and GitHub answers 404, 405, or 422. `classifyRestStatus` in
`src/adapters/github/command-runner.ts` maps those to `CommandNotFound` and
`CommandUnsupported`; `writeFailure` in
`src/adapters/github/github-write-failures.ts` maps both to `unavailable`,
which is the category that keeps the Review locked for ADR 0035
reconciliation. The reconciling read then reports what the first request did.

**Four labels can leave a duplicate the maintainer sees.** Each of them creates
something new, so a second delivery creates a second one:
`POST repos/:owner/:repo/pulls/:n/reviews` from `createDirectSummaryReview`,
`POST repos/:owner/:repo/pulls/:n/comments`, `addPullRequestReviewThread`, and
`addPullRequestReviewThreadReply`. That is the exposure github.com's own
comment form already has, since it posts through the same network stack, and
the worst outcome is one extra comment the maintainer can read and delete.

**One resend drops the write intent: starting a pending review.** If the first
`POST repos/:owner/:repo/pulls/:n/reviews` from `startPendingReviewWithThread`
landed, the resend answers 422 with GitHub's "pending review per pull request"
message. `isPendingReviewFailure` matches that phrase and `classifyRestStatus`
answers `CommandPendingReview` (`command-runner.ts:650-653` and `:837-841`),
which `writeFailure` maps to the `pending_review` category
(`github-write-failures.ts:36-42`). That category is not `unavailable`, so
`executeWrite` in `pending-review-service.ts:575-598` takes the refusal branch:
`rejectPendingReviewWrite` returns `{ _tag: "None" }` for a start
(`domain/pending-review.ts:254-265`), the persisted intent is dropped, and the
service answers `rejected`. The maintainer is told GitHub rejected the
submission and is left with no locked review, while GitHub holds the pending
review the first request created. Nothing stays locked, so ADR 0035
reconciliation never runs for it. The next unlocked reconcile adopts the
observed pending review (`adoptObservedPendingReview`,
`pending-review-service.ts:278`), so the state comes back on a read rather than
through the write path.

Nothing here adds retry logic, and nothing should. What handles a duplicate is
ADR 0035: the intent is persisted before the call, and a write whose outcome is
unknown is reconciled by a read rather than re-sent. This is recorded as the
one part of the write cutover that the loopback fixture server cannot prove,
because it happens below the `fetch` seam.

### Live write check

> **Completed on 2026-09-19.** The run is recorded after the steps. The
> procedure is kept because it is what the evidence means; it cannot be run
> today, because `PATCHDESK_GITHUB_WRITES` is gone.

Run before the default flips, against a throwaway pull request on a throwaway
repository, with the dev app launched as
`PATCHDESK_GITHUB_WRITES=http pnpm dev` and the log tail open. One of each
write family. After every one, confirm three things: the write landed on
GitHub exactly once, the Review write journal entry cleared, and no recovery
banner appeared.

1. Post an inline comment on a diff line. Count it on GitHub's own timeline:
   the app does not show a duplicate as a failure.
2. Reply to the thread it created, and count the replies on GitHub the same
   way.
3. Resolve the thread, then unresolve it.
4. Edit the reply's body.
5. Delete the reply.
6. Add a label, then remove it.
7. Add an assignee.
8. Request a reviewer, then remove the request.
9. Start a pending review on one line, add a second thread to it, then submit
   it. Count the published threads on GitHub's own timeline.
10. Start another pending review and discard it instead.
11. Publish a direct summary review, and count the reviews on GitHub's own
    timeline.
12. Toggle the pull request to draft and back.
13. Leave the app idle for ten minutes, then post one inline comment. Confirm
    it landed exactly once and that the journal entry cleared.

Base-branch change and merge are optional and destructive: run them last, on a
pull request that is finished with, or not at all.

Record the run in this ADR's Cutover record with the date, the commit, and the
`github-http` entry count for each label. A duplicate write, a stuck journal
entry, or a recovery banner stops the flip.

#### The run

2026-09-19, on commit `db25976d`, against throwaway draft pull request #318.
Every write landed on GitHub exactly once, its write intent cleared, and no
recovery banner appeared. No write went through `gh api`.

`github-http` entries per label:

| label | entries |
| --- | --- |
| `DELETE repos/:owner/:repo/pulls/:n/reviews/:n` | 1 |
| `DELETE repos/:owner/:repo/pulls/comments/:n` | 1 |
| `PATCH repos/:owner/:repo/pulls/comments/:n` | 1 |
| `POST repos/:owner/:repo/pulls/:n/comments` | 2 |
| `POST repos/:owner/:repo/pulls/:n/reviews` | 3 |
| `POST repos/:owner/:repo/pulls/:n/reviews/:n/events` | 1 |
| `addAssigneesToAssignable` | 1 |
| `addLabelsToLabelable` | 1 |
| `addPullRequestReviewThread` | 1 |
| `addPullRequestReviewThreadReply` | 1 |
| `convertPullRequestToDraft` | 1 |
| `markPullRequestReadyForReview` | 1 |
| `removeAssigneesFromAssignable` | 1 |
| `removeLabelsFromLabelable` | 1 |
| `resolveReviewThread` | 1 |
| `unresolveReviewThread` | 1 |

Step 8's reviewer request was skipped because it emails a real collaborator, so
`requestReviews` and `DELETE repos/:owner/:repo/pulls/:n/requested_reviewers`
were not exercised. Base-branch change and merge were skipped as optional, so
neither was `updatePullRequest` nor `PUT repos/:owner/:repo/pulls/:n/merge`.
`PUT repos/:owner/:repo/pulls/:n/reviews/:n/dismissals`,
`updatePullRequestReviewComment`, and `deletePullRequestReviewComment` were not
exercised either: the comment edit and delete went through their REST forms.
Step 13's idle window ran from 13:13:41Z to 13:23:58Z; the comment posted after
it landed once.

The check also found a bug that neither transport causes, issue #322, fixed in
pull request #324.

**The rollback switch was temporary.** `PATCHDESK_GITHUB_TRANSPORT=gh`, read
once at composition, left every read on `gh` without a rebuild. It existed for
the soak release that carried the first cutover and was deleted with the
allowlists at T4. It was an operational rollback, not a fallback: nothing
consulted it per call, and no failure ever switched transport. Rolling back now
is a git revert.

A served read spawns nothing, so it writes one `github-http` log entry per
request — method-bearing normalized label, status, duration, and no URL —
which `scripts/gh-spawn-report.mjs` counts in its own section and its own
per-cycle column. Spawn counts therefore keep comparing with the program's
earlier measurements.

## Rejected alternatives

**`gh api --cache`.** It keeps the spawn, which is the larger half of the cost:
even a cache hit pays ~240 ms of process startup, and a conditional request that
comes back 304 pays it too. Its TTL is a duration string outside the app's
control, so nothing Patchdesk knows about a write can invalidate it — the
freshness guarantees the Review path depends on would be at the mercy of a
clock. It also writes response payloads in plaintext under `~/.cache/gh`.

**Reads direct, writes left on `gh`, as a permanent end state.** This is the
right sequence and the wrong destination. Keeping it forever means two failure
classifiers and two error vocabularies maintained in parallel, indefinitely, for
the path whose cost was never the spawn — writes are rare and already dominated
by GitHub's own latency. The cutover moves reads first and writes second
(see the program plan); it does not stop in between.

**Node `fetch` for the writes, to avoid Chromium's resend.** Node's fetch does
not resend a POST, but it also reads no system proxy, no PAC file, and no OS
certificate store. Node 24's `--use-env-proxy` and `--use-system-ca` read
environment variables, which a macOS app launched from Finder does not have,
and `EnvHttpProxyAgent` would add a new `undici` dependency to reach the same
place. With `gh api` gone, a maintainer behind a proxy would have no working
write path at all. It would close one resend window at the cost of
every proxied and private-CA install.

**A dedicated session with `closeAllConnections()` before each write.** It
would not close the window: Chromium counts a fresh HTTP/2 session as reused
once the server's `SETTINGS` frame arrives, so `connection_is_proven` is true
on the first request anyway. It would also abort a write already in flight on
that session.

**Octokit.** It would add a second HTTP client and a second error model on top
of an API surface the adapter already validates field by field with valibot
(ADR 0022). Patchdesk does not use Octokit's response types, so it would be
paying for a dependency to reach the same parsed values it reaches now, through
one more layer whose failures it would have to re-map into `CommandFailure`'s
successors anyway.

## Consequences

- **GHES prefixing cannot be live-verified on this machine.** There is no
  GitHub Enterprise Server account here, so the three-way base URL rule is
  pinned by unit tests only until one exists. That is weaker evidence than the
  rest of this change carries, and it is the one part of it that ships unproven
  against a real host.
- **The fixture contract behind ADR 0024 splits.**
  `tests/fixtures/gh-command-failures/` exists because gh's stderr prose is not
  a stable contract. Fixtures that carry a structured body — a REST error JSON,
  a GraphQL `errors[]` entry — carry over unchanged as HTTP responses, since
  that is the same payload GitHub sent. Fixtures that capture gh's stderr prose
  survive only for the commands that remain, `gh auth` and `git`. The
  `ip_allow_list` attribution ADR 0024 pins to a phrase match keeps its fixture,
  because the phrase is GitHub's, not gh's.
- **The token becomes an in-process request header.** It is still never logged
  and never persisted. Request log records carry method, normalized endpoint
  label, status, and duration — never headers, and never a URL with a query
  string.
- **Proxy and certificate authority behaviour stays with the platform.**
  `gh` read `HTTPS_PROXY` and the system trust store on Patchdesk's behalf, and
  Node's `fetch` reads neither. The client therefore takes the function that
  reaches the network as a constructor option, and the desktop entry point —
  the one module that may import Electron — passes Electron's `net.fetch`
  through `LocalApiConfiguration`: Chromium's stack honours the system proxy
  configuration and the system trust store, so a maintainer behind a proxy or
  a private CA keeps configuring the machine rather than the app. The adapter
  layer stays free of Electron, and so does every other host of the local API
  (the browser suite, the packaged smoke); absent that configuration the
  client keeps Node's `fetch`, which is what the loopback fixture tests run
  against.

  Two Chromium behaviours `gh` did not have are switched off where the fetch
  is injected, both measured against Electron 43 rather than assumed.
  `cache: "no-store"`, because GitHub answers an authenticated read with
  `Cache-Control: private, max-age=60` and Chromium otherwise serves a repeat
  call from its cache without asking GitHub. `credentials: "omit"`, because the
  default session's cookie jar otherwise sends back a cookie GitHub set on an
  earlier response. Chromium's `AbortSignal` support, `Link` and rate-limit
  header reads, streamed body reads, and redirect following were checked in the
  same run and behave as the Node path does.
- **Rate-limit headers become readable.** `X-RateLimit-Remaining`,
  `X-RateLimit-Reset`, and `Retry-After` arrive on every response. ADR 0023
  deferred reading them for exactly one reason — gh exposed them only by
  prefixing them onto stdout ahead of the JSON body — and that reason is gone.
  The opportunistic `rateLimit { remaining resetAt }` field on the inbox query
  stays; the headers make the same knowledge available on every call rather
  than on one.
- **The gh-specific failure classification becomes dead code and is deleted in
  the same release.** With no `gh api` argv left, `extractRestStatusFromStderr`,
  `classifyStructuredFailure`, the gh branches of `classifyByStderrPattern`, and
  the `api` branches of `normalizeCommandLabel` have no input. The plan names
  them in its own slice rather than leaving them to rot.
- **ADR 0026 constrains the cutover.** `canonicalPatchHash` is computed from
  the bytes of GitHub's compare response. The same compare must be hashed
  through both transports and the hashes confirmed equal before the read path
  moves, or every open Review reports a revision change that did not happen.
- **ADR 0035 constrains the write cutover.** `rejected` removes the write
  intent, so only a status that proves GitHub refused may produce it.
  Everything else must answer `unavailable` and keep the Review locked for
  reconciliation, because the mutation may already have landed on GitHub:
  network errors, timeouts, 5xx responses, and a success body that did not
  parse are never a rejection. `writeFailure` in `github-write-failures.ts`
  mapped `CommandFailed` to `rejected` when this was written, which is exactly
  that bug; issue #288 fixed it before the write cutover, and `rejected` is
  now produced only by Patchdesk's own "No review content is selected." check.
  `tests/adapters/github-http-write-failures.test.ts` is the table the HTTP
  transport is pinned against, with the gh path's category asserted beside
  each row.
