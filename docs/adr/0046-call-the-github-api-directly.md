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

`httpServedReadLabels` in `gh-request-runner.ts` is the list of reads served
over HTTPS, named by the label `normalizeCommandLabel` prints. A request is
served there when the runner holds an HTTP transport, the request is a read,
and its label is in the list; everything else spawns `gh api` unchanged, and a
served request is not shadowed because there is no `gh` answer left to compare
it against. There is no fallback in either direction: an HTTP failure is the
read's failure, classified from the response status rather than from stderr.

As of T2 the list holds these twenty labels, each of which read clean against
`gh` for a whole shadow window on two transports first:

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

**A GraphQL label is not enough to be served.** Queries and mutations share one
endpoint and a mutation is labelled by its root field, so a mutation could
carry an allowlisted label. The routing therefore serves a GraphQL request only
when `isQueryDocument` also reads the document as a query, the same predicate
the shadow uses to decide what it may run twice.

**A 200 carrying `errors` is a failure on both transports.** `gh api graphql`
exited nonzero whenever the response held a non-empty `errors` array, partial
`data` beside it included, so every caller has only ever seen that as a
failure. The client classifies the same body through the same
`classifyGraphqlErrorBody`, which now maps `RATE_LIMITED` structurally: gh
reached `CommandRateLimited` through the rate-limit phrase in its own stderr,
and the HTTP transport has no stderr to read.

Two REST reads stay on `gh`, neither observed in a shadow window yet, and both
for the same reason: as of T2 nothing outside the gateway port calls them, so
no window running the app can reach them.

- `api GET repos/:owner/:repo/contents/:path` — `getFileContents` has no
  caller in `src/main`, `src/services`, or the renderer.
- `api GET repos/:owner/:repo/pulls` — the open pull request list;
  `listOpenPullRequests` has no caller there either.

Seven GraphQL queries stay on `gh`, none of them exercised in a shadow window
yet, each for a reason of its own:

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
what kept it off the HTTPS path. T3 gives the writes an allowlist of their own,
below.

**The compare read is hashed, so its bytes are the contract.** `Response.text()`
and a default `TextDecoder` both strip a leading UTF-8 byte order mark; gh
wrote its stdout through Node's utf8 stream decoder, which keeps it. The
client therefore decodes the response stream with `ignoreBOM`, so the bytes
`canonicalPatchHash` covers are the bytes GitHub served (ADR 0026). CRLF
endings, non-ASCII text, and a missing trailing newline already survived
unchanged.

T2 extends the list; T3 adds a second one for the writes, below; T4 deletes
both together with the last `gh api` argv and the gh-specific classification
named under Consequences.

### The writes, and why their proof is different

A read was proven by running both transports on the same call and comparing.
A write cannot be sent twice, so there is no shadow and no comparison window.
Its proof is three other things: request-shape equality against the `gh api`
argv and stdin the same call encodes today, a failure-classification table
driven from real HTTP responses and real socket conditions on a loopback
server, and one manual live check the maintainer runs before the default
flips.

`httpServedWriteLabels` in `gh-request-runner.ts` is the write half of the
cutover record. `transportRouteFor` classifies every request as exactly one of
read, write, or stays-on-gh; the read gate is the unchanged conservative
predicate, so no write can reach the read path by matching a read label. A
write label names **the method GitHub receives**, not the one in the argv:
`gh api --input -` with no `--method` posts, so a body-carrying request
normalizes to a GET label that would otherwise collide with a read's.

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

**The write switch is temporary, and separate from the rollback.**
`PATCHDESK_GITHUB_WRITES=http`, read once in `githubTransports()` beside the
other two, serves those labels over HTTPS. Absent, every write stays on `gh`,
which is the default: a write has no shadow, so it stays a per-launch opt-in
until the live check below passes. `PATCHDESK_GITHUB_TRANSPORT=gh` still
overrides it and puts writes back on `gh` with the reads. After the live check
the default flips and `PATCHDESK_GITHUB_WRITES` goes; T4 deletes both
allowlists.

**Three things the client had to be taught, found by writing the shape tests.**

- *A body with no method is a POST.* `restMethodFor` in `github-request.ts` is
  now the one place that rule lives, read by both the client's `method` and
  the write label. No current call site relies on it — every write names its
  method — but a request that did would have been sent as a GET.
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

**No write is retried, and one risk cannot be closed here.** Neither the
client nor `writeFailure` retries: a failed write is the call's failure, and
there is no fallback to `gh`. Node's `fetch` does not retry either — undici's
retry is opt-in through `RetryAgent`/`RetryHandler` and the default dispatcher
has none. Electron's `net.fetch` is the one that cannot be ruled out.
Chromium's `HttpNetworkTransaction::ShouldResendRequest` reads

    bool connection_is_proven = stream_->IsConnectionReused();
    bool has_received_headers = GetResponseHeaders() != nullptr;
    return connection_is_proven && !has_received_headers;

and the HTTP method is not consulted anywhere in that decision, so a POST on a
reused keep-alive connection that fails with `ERR_CONNECTION_RESET`,
`ERR_CONNECTION_CLOSED`, `ERR_EMPTY_RESPONSE` or `ERR_SOCKET_NOT_CONNECTED`
before any response header arrives is resent by the network stack, invisibly
to this app.

`gh` was not free of this either, but its rule was narrower. Go's
`persistConn.shouldRetryRequest` replays a non-idempotent request on a reused
connection only for `nothingWrittenError` — nothing of the request reached the
socket — and only when the body can be rewound; every other error goes through
`Request.isReplayable`, which a POST without an `Idempotency-Key` header fails.
Chromium asks neither question. So the window in which a write can be sent
twice is wider over `net.fetch` than it was over `gh`, by the amount of a
request that was written before the reset.

Nothing here adds retry logic, and nothing should. What handles a duplicate is
ADR 0035: the intent is persisted before the call, and a write whose outcome is
unknown is reconciled by a read rather than re-sent. This is recorded as the
one part of the write cutover that the loopback fixture server cannot prove,
because it happens below the `fetch` seam.

### Live write check

Run before the default flips, against a throwaway pull request on a throwaway
repository, with the dev app launched as
`PATCHDESK_GITHUB_WRITES=http pnpm dev` and the log tail open. One of each
write family. After every one, confirm three things: the write landed on
GitHub exactly once, the Review write journal entry cleared, and no recovery
banner appeared.

1. Post an inline comment on a diff line.
2. Reply to the thread it created.
3. Resolve the thread, then unresolve it.
4. Edit the reply's body.
5. Delete the reply.
6. Add a label, then remove it.
7. Add an assignee.
8. Request a reviewer, then remove the request.
9. Start a pending review on one line, add a second thread to it, then submit
   it.
10. Start another pending review and discard it instead.
11. Publish a direct summary review.
12. Toggle the pull request to draft and back.

Base-branch change and merge are optional and destructive: run them last, on a
pull request that is finished with, or not at all.

Record the run in this ADR's Cutover record with the date, the commit, and the
`github-http` entry count for each label. A duplicate write, a stuck journal
entry, or a recovery banner stops the flip.

**The rollback switch is temporary.** `PATCHDESK_GITHUB_TRANSPORT=gh`, read
once at composition beside `PATCHDESK_TRANSPORT_SHADOW`, leaves every read on
`gh` without a rebuild. It exists for the soak release that carries the first
cutover and is deleted with the allowlist at T4. It is an operational
rollback, not a fallback: nothing consults it per call, and no failure ever
switches transport.

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
