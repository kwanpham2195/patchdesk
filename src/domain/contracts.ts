import * as v from "valibot";

import {
  parseGitSha,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  type GitSha,
  type PullRequestNumber,
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
  readonly appearance?: Appearance;
  readonly diffTheme?: DiffTheme;
};

export type Appearance = "system" | "light" | "dark";

export type DiffTheme = {
  readonly light: string;
  readonly dark: string;
};

export type PatchdeskSettingsPatch = {
  readonly appearance?: Appearance;
  readonly diffTheme?: DiffTheme;
};

export type GitHubPullRequestDto = {
  readonly number: PullRequestNumber;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly head: { readonly ref: string; readonly sha: GitSha };
  readonly base: { readonly ref: string };
};

export type StartReviewRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly pr: PullRequestRef;
};

/** Valibot schema for the global Patchdesk config file. */
export const patchdeskConfigSchema = v.strictObject({
  lastSelectedProfileId: v.optional(v.string()),
  appearance: v.optional(v.picklist(["system", "light", "dark"])),
  diffTheme: v.optional(
    v.strictObject({
      light: v.pipe(v.string(), v.minLength(1)),
      dark: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
});


/** Valibot schema for the mutable, file-backed settings exposed by the desktop API. */
export const patchdeskSettingsPatchSchema = v.strictObject({
  appearance: v.optional(v.picklist(["system", "light", "dark"])),
  diffTheme: v.optional(
    v.strictObject({
      light: v.pipe(v.string(), v.minLength(1)),
      dark: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
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
  return parsed.success ? parsePatchdeskConfigFields(parsed.output) : invalid("config");
}

/** Parses a complete settings patch and rejects empty or unknown command fields. */
export function parsePatchdeskSettingsPatch(
  input: unknown,
): Result<PatchdeskSettingsPatch, InvalidDomainContract> {
  const parsed = v.safeParse(patchdeskSettingsPatchSchema, input);
  if (
    !parsed.success ||
    (parsed.output.appearance === undefined && parsed.output.diffTheme === undefined)
  ) {
    return invalid("config");
  }

  return ok({
    ...(parsed.output.appearance === undefined ? {} : { appearance: parsed.output.appearance }),
    ...(parsed.output.diffTheme === undefined ? {} : { diffTheme: parsed.output.diffTheme }),
  });
}

function parsePatchdeskConfigFields(input: {
  readonly lastSelectedProfileId?: string | undefined;
  readonly appearance?: Appearance | undefined;
  readonly diffTheme?: DiffTheme | undefined;
}): Result<PatchdeskConfigFile, InvalidDomainContract> {
  if (input.lastSelectedProfileId === undefined) {
    return ok({
      ...(input.appearance === undefined ? {} : { appearance: input.appearance }),
      ...(input.diffTheme === undefined ? {} : { diffTheme: input.diffTheme }),
    });
  }

  const profileId = parseWorkspaceProfileId(input.lastSelectedProfileId);
  if (profileId._tag === "err") return invalid("config");
  return ok({
    lastSelectedProfileId: profileId.value,
    ...(input.appearance === undefined ? {} : { appearance: input.appearance }),
    ...(input.diffTheme === undefined ? {} : { diffTheme: input.diffTheme }),
  });
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
