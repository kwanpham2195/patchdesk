import * as v from "valibot";

import type {
  CheckRunSummary,
  CheckSummary,
} from "../../domain/github-context";

/**
 * The durable on-disk shape of one `CheckSummary`, shared by every store that
 * persists one: `ReviewRemoteStore`'s snapshot and merge policy, and
 * `MaintainerInboxCacheStore`'s rows. `strictObject` follows the ADR "Choose a
 * validation style by data boundary" — Patchdesk owns both the write and the
 * read side, so an unrecognized field means the local copy drifted rather than
 * an external shape evolving underneath it.
 *
 * `url` is a plain string on purpose, and `name` carries no minimum length.
 * The wire projections in `github-wire-projections.ts` drop only `null` and
 * `undefined` from `details_url`/`targetUrl`, so any other string GitHub sends
 * — `""` included — is stored verbatim, and `save()` validates nothing. A
 * `v.url()` or `minLength(1)` refinement here would therefore reject a value
 * Patchdesk itself wrote, and fail the whole read of a record that had
 * round-tripped correctly.
 *
 * What dropping those refinements gave up, stated exactly, because it was not
 * nothing. `v.url()` did reject `""`, `" "`, a path-relative `/o/r/runs/1`, a
 * protocol-relative `//github.com/x`, and a bare `github.com/o/r`, and
 * `minLength(1)` on `name` did reject `""`. What `v.url()` never rejected is
 * `javascript:`, `data:`, `file:`, or a foreign host: it checks that a string
 * parses as a URL, it does not judge the scheme or the origin. It was a
 * well-formedness check that excluded some junk, never the security boundary —
 * which is why removing it costs well-formedness and not safety.
 *
 * The security boundary sits elsewhere and is applied twice, and neither half
 * ever trusted this schema. In the renderer,
 * `resolvePullRequestExternalUrl` (`src/renderer/src/external-links.ts`) is the
 * only route by which a check URL is followed, and it demands `https:` and no
 * port or credentials. The main process then re-checks the same URL
 * independently in `isUserActivatedExternalUrl`
 * (`src/main/external-navigation.ts`) before anything opens.
 *
 * Both halves allow any HTTPS host, because a check's details page routinely
 * lives on the CI provider rather than on GitHub, and following it takes a
 * click. The host allowlist still exists, in `isAllowedExternalUrl`, and still
 * guards `will-navigate` and `setWindowOpenHandler` — navigation the page
 * starts by itself, with no user intent behind it.
 *
 * Not yet carried end to end: `checkRunSchema` in `renderer-contracts.ts` keeps
 * its own `minLength(1)` on both fields at the IPC boundary, so an empty `url`
 * or `name` now survives storage and is rejected one layer later — and because
 * the inbox payload is parsed as a whole, the rejection costs the entire
 * response, not the one row. The durable fix is to normalize `""` to absent in
 * the wire projection, which closes storage, IPC, and renderer together.
 */
export const checksSchema = v.strictObject({
  overall: v.picklist(["passing", "failing", "pending", "skipped", "unknown"]),
  checks: v.array(
    v.strictObject({
      name: v.string(),
      required: v.union([v.boolean(), v.literal("unknown")]),
      status: v.picklist(["queued", "in_progress", "completed", "unknown"]),
      conclusion: v.optional(
        v.picklist([
          "success",
          "failure",
          "cancelled",
          "timed_out",
          "skipped",
          "neutral",
        ]),
      ),
      url: v.optional(v.string()),
    }),
  ),
});

/**
 * Narrows an already-validated stored checks record to the domain
 * `CheckSummary`. Every remaining field is a plain carry-over, so this cannot
 * fail and returns the value rather than a `Result`.
 */
export function projectChecks(
  input: v.InferOutput<typeof checksSchema>,
): CheckSummary {
  return {
    overall: input.overall,
    checks: input.checks.map((check): CheckRunSummary => {
      const conclusionField =
        check.conclusion === undefined ? {} : { conclusion: check.conclusion };
      const urlField = check.url === undefined ? {} : { url: check.url };
      return {
        name: check.name,
        required: check.required,
        status: check.status,
        ...conclusionField,
        ...urlField,
      };
    }),
  };
}
