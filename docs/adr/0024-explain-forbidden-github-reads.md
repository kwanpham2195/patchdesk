# Explain Forbidden GitHub Reads

A forbidden `gh` read receives one of four reasons: `ip_allow_list`, `saml`,
`insufficient_scopes`, or `unknown`. Before this change, Patchdesk grouped these
failures with transient network errors as `unavailable`. The Maintainer Inbox
then offered a retry for an IP allow-list restriction, even though retrying
could not resolve it.

The reason crosses the process boundary as an enum, not as GitHub's raw message.
`GitHubReadFailure` never sends `stdout` or `stderr` to the renderer. The
renderer receives the enum value, never GitHub's raw message.

Patchdesk identifies `saml` and `insufficient_scopes` from structured GraphQL
signals (`extensions.saml_failure` and
`errors[].type === "INSUFFICIENT_SCOPES"`). GitHub has no structured error type
for IP allow lists, so Patchdesk identifies `ip_allow_list` by matching a
specific phrase in GitHub's message. A fixture in
`tests/fixtures/gh-command-failures/` pins that phrase. If GitHub changes its
wording, the test fails rather than silently classifying the error as
`unknown`.

The Maintainer Inbox offers no retry for any forbidden reason, including
`unknown`. Retrying cannot resolve these failures, and a retry button would
suggest otherwise.

The following work remains deferred. The GitHub write path still groups a
forbidden write under `unavailable` in `GitHubWriteFailure` and
`writeFailure()`. Outside the Maintainer Inbox, `dashboard-service.ts` and
these `GitHubReadFailure` consumers still group forbidden reads with other
read failures: `review-diff-source-service.ts`,
`review-workbench-controller.ts`, `review-refresh-service.ts`,
`review-observation-service.ts`, `published-feedback-service.ts`,
`github-revision-identity-reader.ts`, `inline-conversation-service.ts`, and
`local-api.ts`. REST-based `saml` and `insufficient_scopes` attribution also
remains deferred because there is no structured signal or fixture evidence.
