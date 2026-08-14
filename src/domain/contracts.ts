import * as v from "valibot";

import {
  parseWorkspaceProfileId,
  type GitSha,
  type PullRequestNumber,
  type WorkspaceProfileId,
} from "./ids";
import type { PullRequestRef } from "./pull-request";
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

/** Parse the global config boundary into profile IDs that core code can trust. */
export function parsePatchdeskConfig(
  input: unknown,
): Result<PatchdeskConfigFile, InvalidDomainContract> {
  const parsed = v.safeParse(patchdeskConfigSchema, input);
  return parsed.success
    ? parsePatchdeskConfigFields(parsed.output)
    : invalid("config");
}

/** Parses a complete settings patch and rejects empty or unknown command fields. */
export function parsePatchdeskSettingsPatch(
  input: unknown,
): Result<PatchdeskSettingsPatch, InvalidDomainContract> {
  const parsed = v.safeParse(patchdeskSettingsPatchSchema, input);
  if (
    !parsed.success ||
    (parsed.output.appearance === undefined &&
      parsed.output.diffTheme === undefined)
  ) {
    return invalid("config");
  }

  return ok({
    ...(parsed.output.appearance === undefined
      ? {}
      : { appearance: parsed.output.appearance }),
    ...(parsed.output.diffTheme === undefined
      ? {}
      : { diffTheme: parsed.output.diffTheme }),
  });
}

function parsePatchdeskConfigFields(input: {
  readonly lastSelectedProfileId?: string | undefined;
  readonly appearance?: Appearance | undefined;
  readonly diffTheme?: DiffTheme | undefined;
}): Result<PatchdeskConfigFile, InvalidDomainContract> {
  if (input.lastSelectedProfileId === undefined) {
    return ok({
      ...(input.appearance === undefined
        ? {}
        : { appearance: input.appearance }),
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

function invalid(
  boundary: InvalidDomainContract["boundary"],
): Result<never, InvalidDomainContract> {
  return err({ _tag: "InvalidDomainContract", boundary });
}
