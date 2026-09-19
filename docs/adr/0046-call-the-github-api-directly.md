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

A read `gh` projects with `jq` is recorded as skipped rather than compared:
`gh` answers the projected value and the client the whole body, so the two are
not comparable and a standing divergence there would bury the real ones.

Each comparison writes one `transport-shadow` log entry carrying the normalized
endpoint label, the outcome, and where the two first differed — never a
response body, a token, or a header value.
`node scripts/gh-spawn-report.mjs --shadow [--since <iso>] [--until <iso>]`
sums those entries into one row per label, so a label is cut over on a count of
clean reads rather than on a judgement (issue #292).

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
- **ADR 0035 constrains the write cutover.** `writeFailure` in
  `github-write-failures.ts` maps `CommandFailed` to `rejected`, which removes
  the write intent, and everything else to `unavailable`, which keeps the
  Review locked for reconciliation. A transport that reported a dropped
  connection or a 5xx as `CommandFailed` would clear an intent whose mutation
  may already have landed on GitHub. Network errors, timeouts, and 5xx
  responses must classify as unavailable or timed out, never as a rejection.
