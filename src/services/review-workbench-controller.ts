import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../domain/ids";
import { err, type Result } from "../domain/result";
import type { PrepareReviewSessionFailure, ReviewOpenMode, ReviewSessionPreparation } from "./review-session-preparation";
import type {
  RemoteReviewContext,
  ReviewWorkbenchProjection,
  ReviewWorkbenchProjectionService,
  WorkbenchProjectionFailure,
} from "./review-workbench-projection";
import { readObjectField } from "./read-object-field";

export type ReviewWorkbenchFailure = { readonly reason: "invalid_input" | "not_found" | "github_read" | "head_changed" | "storage" };
export type { ReviewWorkbenchProjection };

/**
 * Temporary local-API application facade. It retains the current unknown-input
 * parser and maps precise preparation/projection failures onto the existing
 * route vocabulary. It performs no GitHub reads, comparison work, file I/O, or
 * Session persistence of its own.
 */
export class ReviewWorkbenchController {
  constructor(
    private readonly preparation: ReviewSessionPreparation,
    private readonly projection: ReviewWorkbenchProjectionService,
  ) {}

  async open(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const host = parseGitHubHost(readObjectField(input, "host"));
    const owner = parseGitHubOwner(readObjectField(input, "owner"));
    const repo = parseGitHubRepoName(readObjectField(input, "repo"));
    const number = parsePullRequestNumber(readObjectField(input, "number"));
    if (profileId._tag === "err" || host._tag === "err" || owner._tag === "err" || repo._tag === "err" || number._tag === "err") return err({ reason: "invalid_input" });
    const requestedMode = readObjectField(input, "mode");
    if (requestedMode !== undefined && requestedMode !== "full" && requestedMode !== "incremental") return err({ reason: "invalid_input" });
    let mode: ReviewOpenMode = { kind: "full" };
    if (requestedMode === "incremental") {
      const baseSessionId = parseReviewSessionId(readObjectField(input, "baseSessionId"));
      if (baseSessionId._tag === "err") return err({ reason: "invalid_input" });
      mode = { kind: "incremental", baseSessionId: baseSessionId.value };
    }
    const previousSessionRaw = readObjectField(input, "previousSessionId");
    const parsedPreviousSessionId = previousSessionRaw === undefined
      ? undefined
      : parseReviewSessionId(previousSessionRaw);
    if (parsedPreviousSessionId?._tag === "err") return err({ reason: "invalid_input" });
    const previousSessionId = parsedPreviousSessionId?._tag === "ok"
      ? parsedPreviousSessionId.value
      : mode.kind === "incremental" ? mode.baseSessionId : undefined;
    const prepared = await this.preparation.prepare({
      profileId: profileId.value,
      pullRequest: { host: host.value, owner: owner.value, repo: repo.value, number: number.value },
      mode,
      ...(previousSessionId === undefined ? {} : { previousSessionId }),
    });
    if (prepared._tag === "err") return err(mapPreparationFailure(prepared.error));
    const projected = await this.projection.load({ profileId: profileId.value, sessionId: prepared.value.session.id });
    return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
  }

  async load(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    if (profileId._tag === "err" || sessionId._tag === "err") return err({ reason: "invalid_input" });
    const projected = await this.projection.load({ profileId: profileId.value, sessionId: sessionId.value });
    return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
  }

  async refresh(input: unknown): Promise<Result<RemoteReviewContext, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    if (profileId._tag === "err" || sessionId._tag === "err") return err({ reason: "invalid_input" });
    const refreshed = await this.projection.refreshRemote({ profileId: profileId.value, sessionId: sessionId.value });
    return refreshed._tag === "err" ? err(mapProjectionFailure(refreshed.error)) : refreshed;
  }
}

function mapPreparationFailure(failure: PrepareReviewSessionFailure): ReviewWorkbenchFailure {
  switch (failure._tag) {
    case "ProfileNotFound":
    case "IncrementalBaseNotFound":
      return { reason: "not_found" };
    case "InvalidIncrementalBase":
      return { reason: "invalid_input" };
    case "GitHubReadUnavailable":
      return { reason: "github_read" };
    case "HeadChanged":
      return { reason: "head_changed" };
    case "ProfileUnavailable":
    case "SessionStorageUnavailable":
    case "PreparationUnavailable":
    case "PreparationCleanupUnavailable":
      return { reason: "storage" };
  }
}

function mapProjectionFailure(failure: WorkbenchProjectionFailure): ReviewWorkbenchFailure {
  switch (failure._tag) {
    case "ProfileNotFound":
    case "SessionNotFound":
      return { reason: "not_found" };
    case "SessionStorageUnavailable":
      return { reason: "storage" };
  }
}
