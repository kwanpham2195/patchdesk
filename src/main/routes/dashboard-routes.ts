import type { Hono } from "hono";
import { err } from "../../domain/result";

import { runWithRequestAbortSignal } from "../../adapters/github/command-runner";
import { listAuthenticatedGitHubAccounts } from "../../adapters/github/github-auth-accounts";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_CHECK_STATUS_FILTER_VALUES,
  INBOX_PAGE_SIZES,
  INBOX_REVIEW_STATE_FILTER_VALUES,
  MAX_INBOX_FILTER_AUTHOR_LENGTH,
  MAX_INBOX_FILTER_BASE_BRANCH_LENGTH,
  MAX_INBOX_FILTER_LABELS,
  MAX_INBOX_FILTER_LABEL_LENGTH,
  type InboxCheckStatusFilter,
  type InboxFilter,
  type InboxPageSize,
  type InboxReviewStateFilter,
} from "../../domain/maintainer-inbox";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseWorkspaceProfileId,
} from "../../domain/ids";
import type { InboxRepositoryRef } from "../../services/maintainer-inbox-service";
import { readObjectField } from "../../services/read-object-field";
import type { LocalApiContainer } from "../local-api-container";
import { repositoryLabelListResponse } from "./github-listing-response";
import { response } from "./http-status";
import { jsonBody } from "./json-body";

/** Profiles, settings, the maintainer inbox, the watchlist and the environment probe. */
export function registerDashboardRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const {
    commands,
    dashboard,
    diagnostics,
    github,
    parsedConfiguration,
    recordProfileReloadFailure,
  } = container;
  app.get("/v1/profiles", async (context) => {
    const result = await dashboard.listProfiles();
    if (result._tag === "err")
      await recordProfileReloadFailure("profile-reload-list");
    return response(context, result);
  });
  app.post("/v1/profiles", async (context) =>
    response(context, await dashboard.saveProfile(await jsonBody(context))),
  );
  app.put("/v1/profiles", async (context) =>
    response(context, await dashboard.saveProfile(await jsonBody(context))),
  );
  app.post("/v1/profiles/select", async (context) => {
    const body = await jsonBody(context);
    const id = readObjectField(body, "id");
    const selected = await dashboard.selectProfile(id);
    if (selected._tag === "err") {
      const profileId = parseWorkspaceProfileId(id);
      if (profileId._tag === "ok") {
        await diagnostics.record({
          profileId: profileId.value,
          category: "recovery",
          phase: "profile-switch",
          retryable: true,
          detail: "Profile selection failed.",
        });
      }
    }
    return response(context, selected);
  });
  app.get("/v1/settings", async (context) =>
    response(context, await dashboard.getSettings()),
  );
  app.patch("/v1/settings", async (context) =>
    response(context, await dashboard.updateSettings(await jsonBody(context))),
  );
  app.get("/v1/inbox", async (context) =>
    runWithRequestAbortSignal(context.req.raw.signal, async () => {
      // The filter is a structured, enumerated value — each field is
      // validated against a literal union here, exactly as `state` was
      // validated here. The renderer never sends a GitHub search
      // qualifier string; `buildInboxSearchQuery` in
      // `maintainer-inbox-service.ts` is the only place that composes one.
      const state = context.req.query("state") ?? "open";
      if (state !== "open" && state !== "merged")
        return response(context, err({ reason: "invalid_input" }));
      const pageSize = parseInboxPageSize(context.req.query("pageSize"));
      if (pageSize === undefined)
        return response(context, err({ reason: "invalid_input" }));
      const repository = parseInboxRepositoryQuery(
        context.req.query("host"),
        context.req.query("owner"),
        context.req.query("repo"),
      );
      if (repository === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const labels = parseInboxLabelsQuery(context.req.queries("label") ?? []);
      if (labels === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const awaitingMyReview = parseInboxBooleanQuery(
        context.req.query("awaitingMyReview"),
      );
      if (awaitingMyReview === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const reviewState = parseInboxReviewStateQuery(
        context.req.query("reviewState"),
      );
      if (reviewState === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const checkStatus = parseInboxCheckStatusQuery(
        context.req.query("checkStatus"),
      );
      if (checkStatus === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const author = parseInboxAuthorQuery(context.req.query("author"));
      if (author === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const baseBranch = parseInboxBaseBranchQuery(context.req.query("base"));
      if (baseBranch === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const labelsField = labels.length === 0 ? {} : { labels };
      const awaitingMyReviewField = awaitingMyReview
        ? { awaitingMyReview }
        : {};
      const reviewStateField = reviewState === undefined ? {} : { reviewState };
      const checkStatusField = checkStatus === undefined ? {} : { checkStatus };
      const authorField = author === undefined ? {} : { author };
      const baseBranchField = baseBranch === undefined ? {} : { baseBranch };
      const filter: InboxFilter = {
        state,
        ...labelsField,
        ...awaitingMyReviewField,
        ...reviewStateField,
        ...checkStatusField,
        ...authorField,
        ...baseBranchField,
      };
      const page = context.req.query("page");
      const result = await dashboard.inboxForActiveProfile(
        repository,
        page === undefined
          ? { filter, pageSize }
          : { filter, pageSize, pageToken: page },
      );
      if (result._tag === "err")
        await recordProfileReloadFailure("profile-reload-inbox");
      return response(context, result);
    }),
  );
  // Repository-scoped, never Review-scoped: `GET /v1/reviews/labels` cannot
  // serve the Pull requests screen's label filter because it resolves the
  // repository through a Review session (`requireCurrentSession`), and the
  // screen has no `reviewId`. This route reads `github.listRepositoryLabels`
  // directly rather than through `LabelService` — labels for a filter
  // picker never need that service's write gate or its resolved permission,
  // and the inbox is read-only.
  app.get("/v1/inbox/labels", async (context) =>
    runWithRequestAbortSignal(context.req.raw.signal, async () => {
      const repository = parseInboxRepositoryQuery(
        context.req.query("host"),
        context.req.query("owner"),
        context.req.query("repo"),
      );
      if (repository === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      // Validated against the active profile's watchlist before any GitHub
      // call, exactly as `GET /v1/inbox` validates its own `repository`
      // query params — without this a renderer could read labels from any
      // repository the active token can see, not just a watched one.
      const resolved = await dashboard.activeProfileRepository(repository);
      if (resolved._tag === "err") return response(context, resolved);
      if (resolved.value.repository === undefined)
        return context.json({ state: "ready", labels: [], totalCount: 0 });
      return repositoryLabelListResponse(
        context,
        await github.listRepositoryLabels({
          profile: resolved.value.profile,
          repo: resolved.value.repository,
        }),
      );
    }),
  );
  app.post("/v1/watchlist", async (context) =>
    response(
      context,
      await dashboard.addWatchlistRepo(await jsonBody(context)),
    ),
  );
  app.patch("/v1/watchlist/path", async (context) =>
    response(context, await dashboard.setLocalPath(await jsonBody(context))),
  );
  app.delete("/v1/watchlist", async (context) =>
    response(
      context,
      await dashboard.removeWatchlistRepo(await jsonBody(context)),
    ),
  );

  app.get("/v1/watchlist/suggestions", async (context) =>
    response(context, await dashboard.discoverWorkspaceRepos()),
  );
  app.post("/v1/github/access", async (context) =>
    response(context, await dashboard.testGitHubAccess()),
  );
  app.get("/v1/environment", async (context) => {
    const [git, gh, ghAuth, githubAccounts] = await Promise.all([
      commands.runText({ argv: ["git", "--version"], timeoutMs: 5_000 }),
      commands.runText({ argv: ["gh", "--version"], timeoutMs: 5_000 }),
      commands.runText({ argv: ["gh", "auth", "status"], timeoutMs: 10_000 }),
      listAuthenticatedGitHubAccounts(commands, 10_000),
    ]);
    return context.json({
      ...(parsedConfiguration.output.appMetadata ?? {
        productName: "Patchdesk",
        version: "development",
        architecture: process.arch,
        distribution: "development" as const,
      }),
      git: git._tag === "ok" ? "ready" : "missing",
      gh: gh._tag === "ok" ? "ready" : "missing",
      githubAuth:
        ghAuth._tag === "ok"
          ? "ready"
          : ghAuth.error._tag === "CommandAuthenticationRequired"
            ? "authentication_required"
            : "unavailable",
      githubAccounts,
      runtime: "bundled",
    });
  });
}

/** A missing value means the default; anything else must be one of the listed sizes exactly. */
function parseInboxPageSize(
  value: string | undefined,
): InboxPageSize | undefined {
  if (value === undefined) return DEFAULT_INBOX_PAGE_SIZE;
  return INBOX_PAGE_SIZES.find((size) => String(size) === value);
}

/**
 * Parses the `GET /v1/inbox` repository query params. All three are omitted
 * together when the renderer has not learned the active profile's watchlist
 * yet (the bootstrap request); `DashboardController.inboxForActiveProfile`
 * falls back to the profile's first watched repository in that case. A
 * request that supplies any of the three but fails to parse as a genuine
 * GitHub host/owner/repo is malformed, not omitted, so it is rejected here
 * rather than silently falling back — the watchlist-membership check itself
 * lives in the controller, which already holds the active profile.
 */
function parseInboxRepositoryQuery(
  host: string | undefined,
  owner: string | undefined,
  repo: string | undefined,
): InboxRepositoryRef | undefined | "invalid" {
  if (host === undefined && owner === undefined && repo === undefined)
    return undefined;
  const parsedHost = parseGitHubHost(host);
  const parsedOwner = parseGitHubOwner(owner);
  const parsedRepo = parseGitHubRepoName(repo);
  if (
    parsedHost._tag === "err" ||
    parsedOwner._tag === "err" ||
    parsedRepo._tag === "err"
  )
    return "invalid";
  return {
    host: parsedHost.value,
    owner: parsedOwner.value,
    repo: parsedRepo.value,
  };
}

/**
 * Validates the `GET /v1/inbox` `label` query param(s) — repeatable, one per
 * selected label — into the structured filter `buildInboxSearchQuery`
 * composes into `label:"NAME"` qualifiers. Bounded by count and length so
 * the composed query cannot exceed GitHub's 256-character search cap, and
 * stripped of the double quote a label name would otherwise use to break
 * out of its own qualifier. This is the injection boundary ADR 0031/0032
 * name: the renderer sends label names, never GitHub search-qualifier text.
 */
/**
 * Validates a boolean `GET /v1/inbox` filter param — today the "Awaiting
 * review from you" preset. Absent means off; only the spellings a
 * `URLSearchParams` caller would produce are accepted, and anything else is
 * `invalid_input` rather than a silent false, so a typo in the query string
 * is reported instead of quietly widening the listing.
 */
function parseInboxBooleanQuery(
  value: string | undefined,
): boolean | "invalid" {
  if (value === undefined) return false;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return "invalid";
}

/** Parses the optional GitHub `review:<value>` qualifier without widening an invalid value. */
function parseInboxReviewStateQuery(
  value: string | undefined,
): InboxReviewStateFilter | undefined | "invalid" {
  if (value === undefined) return undefined;
  return (
    INBOX_REVIEW_STATE_FILTER_VALUES.find((candidate) => candidate === value) ??
    "invalid"
  );
}

/** Parses the optional GitHub `status:<value>` qualifier without widening an invalid value. */
function parseInboxCheckStatusQuery(
  value: string | undefined,
): InboxCheckStatusFilter | undefined | "invalid" {
  if (value === undefined) return undefined;
  return (
    INBOX_CHECK_STATUS_FILTER_VALUES.find((candidate) => candidate === value) ??
    "invalid"
  );
}

/**
 * Parses the optional GitHub `author:<value>` qualifier — one login, or the
 * literal `@me`, which GitHub resolves to the authenticated viewer server-side
 * exactly as it does for `user-review-requested:@me`, so Patchdesk never looks
 * the login up.
 */
function parseInboxAuthorQuery(
  value: string | undefined,
): string | undefined | "invalid" {
  return parseInboxQualifierTextQuery(value, MAX_INBOX_FILTER_AUTHOR_LENGTH);
}

/** Parses the optional GitHub `base:<value>` qualifier — one base branch name. */
function parseInboxBaseBranchQuery(
  value: string | undefined,
): string | undefined | "invalid" {
  return parseInboxQualifierTextQuery(
    value,
    MAX_INBOX_FILTER_BASE_BRANCH_LENGTH,
  );
}

/**
 * The shared rule for the single-value free-text qualifiers. Absent means the
 * filter is off; anything present must survive `trim()` non-empty, stay within
 * its own length cap, and carry none of the double quote, whitespace, or
 * control character that would let a value close its own `author:"NAME"`
 * qualifier and open a second one. This is the same injection boundary
 * `parseInboxLabelsQuery` guards, so an unusable value is `invalid_input`
 * rather than a silently dropped filter.
 */
function parseInboxQualifierTextQuery(
  value: string | undefined,
  maxLength: number,
): string | undefined | "invalid" {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maxLength ||
    containsQuoteOrControlCharacter(trimmed) ||
    containsWhitespace(trimmed)
  )
    return "invalid";
  return trimmed;
}

function parseInboxLabelsQuery(
  values: ReadonlyArray<string>,
): ReadonlyArray<string> | "invalid" {
  if (values.length > MAX_INBOX_FILTER_LABELS) return "invalid";
  const labels: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_INBOX_FILTER_LABEL_LENGTH ||
      containsQuoteOrControlCharacter(trimmed)
    )
      return "invalid";
    labels.push(trimmed);
  }
  return labels;
}

/** Rejects the double quote a label would otherwise use to break out of its
 * own `label:"NAME"` qualifier, and any control character (including
 * newlines) — a real GitHub label name has no legitimate use for either. */
function containsQuoteOrControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (value[i] === '"' || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Rejects the interior whitespace that would end a quoted qualifier early and
 * start a second one. Kept apart from `containsQuoteOrControlCharacter`
 * because a GitHub label name may legitimately contain a space, while a login
 * and a branch name may not. */
function containsWhitespace(value: string): boolean {
  return /\s/u.test(value);
}
