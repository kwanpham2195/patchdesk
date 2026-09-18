import * as v from "valibot";

import { FORBIDDEN_REASONS } from "../../domain/github-forbidden-reason";
import type { RawJsonValue } from "../../domain/json";

// Lives beside `renderer-contracts.ts` so that file stays under the size ceiling.
const baseBranchListResponseSchema = v.strictObject({
  state: v.picklist([
    "ready",
    "github_auth",
    "github_read",
    "github_rate_limited",
    "github_forbidden",
  ]),
  current: v.optional(v.pipe(v.string(), v.minLength(1))),
  branches: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  branchesTotalCount: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  permission: v.optional(v.picklist(["permitted", "denied", "unknown"])),
  resumeAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  forbiddenReason: v.optional(v.picklist(FORBIDDEN_REASONS)),
});

/** `GET /v1/reviews/base-branch`: the base-branch picker's read, or the GitHub read failure. */
export type BaseBranchListResponse = v.InferOutput<
  typeof baseBranchListResponseSchema
>;

/** Parses the local API's base-branch listing before the picker renders it. */
export function parseBaseBranchListResponse(
  input: RawJsonValue | undefined,
): BaseBranchListResponse | undefined {
  const parsed = v.safeParse(baseBranchListResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}
