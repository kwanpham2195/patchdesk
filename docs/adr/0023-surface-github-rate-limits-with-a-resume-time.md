# Surface GitHub Rate Limits With A Resume Time

> **Superseded in part by ADR 0032, "Refresh the pull requests screen only when
> asked".** The poll scheduler described here has been removed, including its
> capped backoff and wait for a learned resume time. Patchdesk still classifies
> rate limits and learns the resume time from the listing query's `rateLimit`
> field. It caches that time per GitHub host, so other GitHub reads and writes
> can report it.

> **ADR 0046, "Call the GitHub API directly", lifts the header deferral below.**
> `gh` exposed response headers only by prefixing them onto stdout before the
> JSON body. Patchdesk now makes the HTTPS request itself and can read headers
> from every response. The listing query's `rateLimit { remaining resetAt }`
> field still works, and Patchdesk still caches its value per host.

A GitHub rate limit has its own failure tag on both read and write paths. The
Maintainer Inbox poll, pending reviews, direct-summary reviews, inline
conversation writes, and merges report it as a rate limit instead of treating
it as a rejection or an unknown outcome.

The listing GraphQL query already includes `rateLimit { remaining resetAt }`.
Patchdesk caches the reset time from a successful response for that GitHub
host. A later rate-limited call can then report when access should resume.

When a read is rate-limited, Patchdesk disables retry and waits for the learned
resume time. If it has not observed a reset time, it waits up to sixty minutes.
The poll scheduler bypasses its usual capped backoff during that wait. A rate
limit for one repository does not delay healthy repositories; the poll waits
only when every repository is blocked.

This record deferred reading `Retry-After` and `X-RateLimit-Reset` because
`gh` exposed response headers only by prefixing them to stdout before the JSON
body. Reading those headers would have required changes to how every adapter
captures and parses `gh` output. ADR 0046 removes that limitation by making
GitHub requests directly over HTTPS.
