import { basename } from "node:path";

import type { Context, Hono } from "hono";
import {
  array,
  integer,
  literal,
  maxLength,
  nullable,
  minLength,
  minValue,
  number,
  optional,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
  variant,
  type InferOutput,
  type SafeParseResult,
} from "valibot";

import {
  changeIntentSchema,
  parseChangeIntent,
} from "../../domain/change-intent";
import {
  parseAbsolutePath,
  parseFindingId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitShaPrefix,
  parseInsightRunId,
  parseLocalBranchName,
  parseLocalNoteId,
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type FindingId,
} from "../../domain/ids";
import { MAX_MAINTAINER_NOTE_LENGTH } from "../../domain/local-draft";
import { ok } from "../../domain/result";
import type { LocalReviewSourceRequest } from "../../domain/review-source";
import type { LocalApiContainer } from "../local-api-container";
import { localReviewResponse, response } from "./http-status";
import { jsonBody } from "./json-body";
import {
  parseReviewWriteExpectation,
  reviewWriteExpectationSchema,
} from "./pending-review-command";

/** Opening a local Review on a profile repository's checkout, applying suggestions to it, and its Local drafts (ADR 0050). */
export function registerLocalReviewRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  app.post("/v1/reviews/open-local", async (context) => {
    const parsed = safeParse(localReviewOpenSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const host = parseGitHubHost(parsed.output.host);
    const owner = parseGitHubOwner(parsed.output.owner);
    const repo = parseGitHubRepoName(parsed.output.repo);
    const request = parseSourceRequest(parsed.output.source);
    if (
      profileId._tag === "err" ||
      host._tag === "err" ||
      owner._tag === "err" ||
      repo._tag === "err" ||
      request === undefined
    )
      return context.json({ error: "invalid_input" }, 400);
    const opened = await container.localReviewOpening.open({
      profileId: profileId.value,
      repository: { host: host.value, owner: owner.value, repo: repo.value },
      request,
    });
    return localReviewResponse(context, opened);
  });

  // The checkouts the open dialog offers: the configured one and its live linked worktrees (#489).
  app.get("/v1/reviews/local-checkouts", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const host = parseGitHubHost(context.req.query("host"));
    const owner = parseGitHubOwner(context.req.query("owner"));
    const repo = parseGitHubRepoName(context.req.query("repo"));
    if (
      profileId._tag === "err" ||
      host._tag === "err" ||
      owner._tag === "err" ||
      repo._tag === "err"
    )
      return context.json({ error: "invalid_input" }, 400);
    const listed = await container.localReviewOpening.listCheckouts(
      profileId.value,
      { host: host.value, owner: owner.value, repo: repo.value },
    );
    return response(
      context,
      listed._tag === "ok"
        ? ok(
            listed.value.map((checkout) => ({
              path: checkout.path,
              name: basename(checkout.path),
              head: checkout.head,
              configured: checkout.configured,
            })),
          )
        : listed,
    );
  });

  // Reads the stored source from the checkout again; a changed one moves the Review and its drafts to a new session (#452).
  app.post("/v1/reviews/local-refresh", async (context) => {
    const parsed = safeParse(reviewIdentitySchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const refreshed = await container.localReviewOpening.refresh(
      profileId.value,
      reviewId.value,
    );
    return localReviewResponse(context, refreshed);
  });

  // Identity only: the main process derives every range and replacement (ADR 0048).
  app.post("/v1/reviews/local-apply", async (context) => {
    const parsed = safeParse(localApplySchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    const runId = parseInsightRunId(parsed.output.runId);
    const expected = parseReviewWriteExpectation(parsed.output.expected);
    const findingIds: FindingId[] = [];
    for (const raw of parsed.output.findingIds) {
      const findingId = parseFindingId(raw);
      if (findingId._tag === "err")
        return context.json({ error: "invalid_input" }, 400);
      findingIds.push(findingId.value);
    }
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      runId._tag === "err" ||
      expected === undefined
    )
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localApply.apply({
        profileId: profileId.value,
        reviewId: reviewId.value,
        runId: runId.value,
        findingIds,
        expected,
      }),
    );
  });

  // Identity only: the main process reads the Finding, its anchor, and its suggestion (ADR 0050 "Local drafts").
  app.post("/v1/reviews/local-drafts/add", async (context) =>
    localDraftResponse(
      context,
      container,
      "add",
      safeParse(localDraftSchema, await jsonBody(context)),
    ),
  );
  app.post("/v1/reviews/local-drafts/remove", async (context) =>
    localDraftResponse(
      context,
      container,
      "remove",
      safeParse(localDraftSchema, await jsonBody(context)),
    ),
  );

  // The renderer names the lines; the main process fingerprints them against the session patch (ADR 0051 "Maintainer notes").
  app.post("/v1/reviews/local-drafts/notes/add", async (context) => {
    const parsed = safeParse(localNoteAddSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const key = parseDraftWriteKey(parsed.output);
    const path = parseRepoRelativePath(parsed.output.path);
    if (
      key === undefined ||
      path._tag === "err" ||
      parsed.output.line < parsed.output.startLine
    )
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localDrafts.addNote({
        ...key,
        anchor: {
          path: path.value,
          side: parsed.output.side,
          startLine: parsed.output.startLine,
          line: parsed.output.line,
        },
        text: parsed.output.text,
      }),
    );
  });
  app.post("/v1/reviews/local-drafts/notes/edit", async (context) => {
    const parsed = safeParse(localNoteEditSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const note = parseNoteKey(parsed.output);
    if (note === undefined)
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localDrafts.editNote({
        ...note,
        text: parsed.output.text,
      }),
    );
  });
  app.post("/v1/reviews/local-drafts/notes/remove", async (context) => {
    const parsed = safeParse(localNoteSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const note = parseNoteKey(parsed.output);
    if (note === undefined)
      return context.json({ error: "invalid_input" }, 400);
    return response(context, await container.localDrafts.removeNote(note));
  });

  // Sets the Change intent, or clears it with `intent: null` (#467); the Analysis start reads a spec file.
  app.post("/v1/reviews/local-intent", async (context) => {
    const parsed = safeParse(localIntentSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    const intent =
      parsed.output.intent === null
        ? ok(undefined)
        : parseChangeIntent(parsed.output.intent);
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      intent._tag === "err"
    )
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localChangeIntent.set({
        profileId: profileId.value,
        reviewId: reviewId.value,
        intent: intent.value,
      }),
    );
  });

  app.post("/v1/reviews/local-drafts/agent-prompt", async (context) => {
    const parsed = safeParse(reviewIdentitySchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localDrafts.agentPrompt(profileId.value, reviewId.value),
    );
  });

  // Reads file hashes only; it never applies again.
  app.post("/v1/reviews/local-apply/recover", async (context) => {
    const parsed = safeParse(reviewIdentitySchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localApply.recover(profileId.value, reviewId.value),
    );
  });
}

async function localDraftResponse(
  context: Context,
  container: LocalApiContainer,
  action: "add" | "remove",
  parsed: SafeParseResult<typeof localDraftSchema>,
): Promise<Response> {
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const key = parseDraftWriteKey(parsed.output);
  const runId = parseInsightRunId(parsed.output.runId);
  const findingId = parseFindingId(parsed.output.findingId);
  if (key === undefined || runId._tag === "err" || findingId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const request = { ...key, runId: runId.value, findingId: findingId.value };
  return response(
    context,
    action === "add"
      ? await container.localDrafts.add(request)
      : await container.localDrafts.remove(request),
  );
}

/** A draft write names the session the workbench displays; the service refuses another one (#452). */
const draftWriteKeySchema = {
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  sessionId: pipe(string(), minLength(1)),
};

function parseDraftWriteKey(raw: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly sessionId: string;
}) {
  const profileId = parseWorkspaceProfileId(raw.profileId);
  const reviewId = parseReviewId(raw.reviewId);
  const sessionId = parseReviewSessionId(raw.sessionId);
  return profileId._tag === "err" ||
    reviewId._tag === "err" ||
    sessionId._tag === "err"
    ? undefined
    : {
        profileId: profileId.value,
        reviewId: reviewId.value,
        sessionId: sessionId.value,
      };
}

const localDraftSchema = strictObject({
  ...draftWriteKeySchema,
  runId: pipe(string(), minLength(1)),
  findingId: pipe(string(), minLength(1)),
});

const noteText = pipe(string(), maxLength(MAX_MAINTAINER_NOTE_LENGTH));
const lineNumber = pipe(number(), integer(), minValue(1));

const localNoteAddSchema = strictObject({
  ...draftWriteKeySchema,
  path: pipe(string(), minLength(1)),
  side: picklist(["new", "old"]),
  startLine: lineNumber,
  line: lineNumber,
  text: noteText,
});

const localNoteSchema = strictObject({
  ...draftWriteKeySchema,
  noteId: pipe(string(), minLength(1)),
});

const localNoteEditSchema = strictObject({
  ...localNoteSchema.entries,
  text: noteText,
});

function parseNoteKey(raw: InferOutput<typeof localNoteSchema>) {
  const key = parseDraftWriteKey(raw);
  const noteId = parseLocalNoteId(raw.noteId);
  return key === undefined || noteId._tag === "err"
    ? undefined
    : { ...key, noteId: noteId.value };
}

const localApplySchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  runId: pipe(string(), minLength(1)),
  findingIds: pipe(array(string()), minLength(1), maxLength(50)),
  expected: reviewWriteExpectationSchema,
});

/** Names one Review and nothing else. */
const reviewIdentitySchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
});

const localIntentSchema = strictObject({
  ...reviewIdentitySchema.entries,
  intent: nullable(changeIntentSchema),
});

const nonEmpty = pipe(string(), minLength(1));
const localReviewOpenSchema = strictObject({
  profileId: nonEmpty,
  host: nonEmpty,
  owner: nonEmpty,
  repo: nonEmpty,
  source: variant("kind", [
    strictObject({
      kind: literal("working_tree"),
      expectedHead: optional(
        variant("kind", [
          strictObject({ kind: literal("branch"), branch: nonEmpty }),
          strictObject({ kind: literal("detached") }),
        ]),
      ),
      checkout: optional(nonEmpty),
    }),
    strictObject({
      kind: literal("branch"),
      branch: nonEmpty,
      baseBranch: nonEmpty,
      checkout: optional(nonEmpty),
    }),
    strictObject({
      kind: literal("commit"),
      commit: nonEmpty,
      checkout: optional(nonEmpty),
    }),
  ]),
});

/** The source request with its checkout, which must be an absolute path (#489). */
function parseSourceRequest(
  raw: InferOutput<typeof localReviewOpenSchema>["source"],
): LocalReviewSourceRequest | undefined {
  const spec = parseSourceSpec(raw);
  if (spec === undefined || raw.checkout === undefined) return spec;
  const checkout = parseAbsolutePath(raw.checkout);
  return checkout._tag === "ok"
    ? { ...spec, checkout: checkout.value }
    : undefined;
}

function parseSourceSpec(
  raw: InferOutput<typeof localReviewOpenSchema>["source"],
): LocalReviewSourceRequest | undefined {
  if (raw.kind === "working_tree") {
    if (raw.expectedHead === undefined) return { kind: "working_tree" };
    if (raw.expectedHead.kind === "detached")
      return { kind: "working_tree", expectedHead: { kind: "detached" } };
    const expected = parseLocalBranchName(raw.expectedHead.branch);
    return expected._tag === "ok"
      ? {
          kind: "working_tree",
          expectedHead: { kind: "branch", branch: expected.value },
        }
      : undefined;
  }
  if (raw.kind === "commit") {
    const commit = parseGitShaPrefix(raw.commit.toLowerCase());
    return commit._tag === "ok"
      ? { kind: "commit", commit: commit.value }
      : undefined;
  }
  const branch = parseLocalBranchName(raw.branch);
  const baseBranch = parseLocalBranchName(raw.baseBranch);
  return branch._tag === "ok" && baseBranch._tag === "ok"
    ? { kind: "branch", branch: branch.value, baseBranch: baseBranch.value }
    : undefined;
}
