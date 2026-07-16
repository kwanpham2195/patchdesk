import * as v from "valibot";

import {
  parseGitSha,
  parsePullRequestNumber,
  parseReviewAttemptId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type GitSha,
  type PullRequestNumber,
  type ReviewAttemptId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import { parsePullRequestInput, type PullRequestRef } from "./pull-request";
import {
  modelReviewResultSchema,
  parseModelReviewResult,
  type ModelReviewResult,
} from "./review-result";
import { err, ok, type Result } from "./result";

export type InvalidDomainContract = {
  readonly _tag: "InvalidDomainContract";
  readonly boundary: "config" | "github" | "storage" | "flue" | "ui";
};

export type PatchdeskConfigFile = {
  readonly lastSelectedProfileId?: WorkspaceProfileId;
  readonly recentPrs: ReadonlyArray<string>;
};

export type GitHubPullRequestDto = {
  readonly number: PullRequestNumber;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly head: { readonly ref: string; readonly sha: GitSha };
  readonly base: { readonly ref: string };
};

export type ReviewSessionStorageFile = {
  readonly id: ReviewSessionId;
  readonly currentAttemptId?: ReviewAttemptId;
  readonly state: { readonly _tag: "Created" } | { readonly _tag: "Running"; readonly attemptId: ReviewAttemptId };
};

export type ReviewPrWorkflowInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly attemptId: ReviewAttemptId;
  readonly worktreePath: string;
};

export type StartReviewRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly pr: PullRequestRef;
};

/** Valibot schema for the global Patchdesk config file. */
export const patchdeskConfigSchema = v.strictObject({
  lastSelectedProfileId: v.optional(v.string()),
  recentPrs: v.array(v.string()),
});

/** Valibot schema for the GitHub pull-request DTO used by Patchdesk's adapter boundary. */
export const githubPullRequestDtoSchema = v.strictObject({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.string(),
  state: v.picklist(["open", "closed"]),
  draft: v.boolean(),
  head: v.strictObject({ ref: v.string(), sha: v.string() }),
  base: v.strictObject({ ref: v.string() }),
});

/** Valibot schema for the minimal session.json projection owned by the storage boundary. */
export const reviewSessionStorageFileSchema = v.strictObject({
  id: v.string(),
  currentAttemptId: v.optional(v.string()),
  state: v.variant("_tag", [
    v.strictObject({ _tag: v.literal("Created") }),
    v.strictObject({ _tag: v.literal("Running"), attemptId: v.string() }),
  ]),
});

/** Valibot schema for Flue's parsed attempt input. */
export const reviewPrWorkflowInputSchema = v.strictObject({
  profileId: v.string(),
  sessionId: v.string(),
  attemptId: v.string(),
  worktreePath: v.pipe(v.string(), v.minLength(1)),
});

/** Valibot schema for a Flue model result before Patchdesk maps finding locations. */
export const reviewPrWorkflowOutputSchema = modelReviewResultSchema;

/** Valibot schema for the direct-review UI/API request body. */
export const startReviewRequestSchema = v.strictObject({
  profileId: v.string(),
  value: v.pipe(v.string(), v.minLength(1)),
});

/** Parse the global config boundary into profile IDs that core code can trust. */
export function parsePatchdeskConfig(input: unknown): Result<PatchdeskConfigFile, InvalidDomainContract> {
  const parsed = v.safeParse(patchdeskConfigSchema, input);
  if (!parsed.success) return invalid("config");

  if (parsed.output.lastSelectedProfileId === undefined) {
    return ok({ recentPrs: parsed.output.recentPrs });
  }

  const profileId = parseWorkspaceProfileId(parsed.output.lastSelectedProfileId);
  if (profileId._tag === "err") return invalid("config");
  return ok({ lastSelectedProfileId: profileId.value, recentPrs: parsed.output.recentPrs });
}

/** Parse a GitHub DTO without allowing adapter-shaped data into the domain unchecked. */
export function parseGitHubPullRequestDto(
  input: unknown,
): Result<GitHubPullRequestDto, InvalidDomainContract> {
  const parsed = v.safeParse(githubPullRequestDtoSchema, input);
  if (!parsed.success) return invalid("github");

  const number = parsePullRequestNumber(parsed.output.number);
  const headSha = parseGitSha(parsed.output.head.sha);
  if (number._tag === "err" || headSha._tag === "err") return invalid("github");
  return ok({
    number: number.value,
    title: parsed.output.title,
    state: parsed.output.state,
    draft: parsed.output.draft,
    head: { ref: parsed.output.head.ref, sha: headSha.value },
    base: { ref: parsed.output.base.ref },
  });
}

/** Parse a session storage projection into branded identifiers before service logic uses it. */
export function parseReviewSessionStorageFile(
  input: unknown,
): Result<ReviewSessionStorageFile, InvalidDomainContract> {
  const parsed = v.safeParse(reviewSessionStorageFileSchema, input);
  if (!parsed.success) return invalid("storage");

  const id = parseReviewSessionId(parsed.output.id);
  const currentAttemptId = parsed.output.currentAttemptId === undefined
    ? undefined
    : parseReviewAttemptId(parsed.output.currentAttemptId);
  const stateAttemptId = parsed.output.state._tag === "Running"
    ? parseReviewAttemptId(parsed.output.state.attemptId)
    : undefined;
  if (
    id._tag === "err" ||
    (currentAttemptId !== undefined && currentAttemptId._tag === "err") ||
    (stateAttemptId !== undefined && stateAttemptId._tag === "err")
  ) return invalid("storage");

  if (parsed.output.state._tag === "Running") {
    if (stateAttemptId === undefined) {
      return invalid("storage");
    }
    return ok({
      id: id.value,
      ...(currentAttemptId === undefined ? {} : { currentAttemptId: currentAttemptId.value }),
      state: { _tag: "Running", attemptId: stateAttemptId.value },
    });
  }

  return ok({
    id: id.value,
    ...(currentAttemptId === undefined ? {} : { currentAttemptId: currentAttemptId.value }),
    state: { _tag: "Created" },
  });
}

/** Parse the Flue workflow's supplied context, which is already serializable and path-safe. */
export function parseReviewPrWorkflowInput(
  input: unknown,
): Result<ReviewPrWorkflowInput, InvalidDomainContract> {
  const parsed = v.safeParse(reviewPrWorkflowInputSchema, input);
  if (!parsed.success || !parsed.output.worktreePath.startsWith("/")) return invalid("flue");

  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const sessionId = parseReviewSessionId(parsed.output.sessionId);
  const attemptId = parseReviewAttemptId(parsed.output.attemptId);
  if (profileId._tag === "err" || sessionId._tag === "err" || attemptId._tag === "err") return invalid("flue");
  return ok({
    profileId: profileId.value,
    sessionId: sessionId.value,
    attemptId: attemptId.value,
    worktreePath: parsed.output.worktreePath,
  });
}

/** Parse Flue output using the model-result boundary that excludes trusted location mapping. */
export function parseReviewPrWorkflowOutput(
  input: unknown,
): Result<ModelReviewResult, InvalidDomainContract> {
  const parsed = parseModelReviewResult(input);
  return parsed._tag === "ok" ? ok(parsed.value) : invalid("flue");
}

/** Parse the UI/API request body into branded profile and PR references before service use. */
export function parseStartReviewRequest(
  input: unknown,
): Result<StartReviewRequest, InvalidDomainContract> {
  const parsed = v.safeParse(startReviewRequestSchema, input);
  if (!parsed.success) return invalid("ui");

  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const pr = parsePullRequestInput(parsed.output.value);
  if (profileId._tag === "err" || pr._tag === "err") return invalid("ui");
  return ok({ profileId: profileId.value, pr: pr.value });
}

function invalid(
  boundary: InvalidDomainContract["boundary"],
): Result<never, InvalidDomainContract> {
  return err({ _tag: "InvalidDomainContract", boundary });
}
