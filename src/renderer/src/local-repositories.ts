import * as v from "valibot";
import type { RepositoryIdentity } from "#src/domain/repository-identity";

export type LocalRepositoryTarget =
  | RepositoryIdentity
  | { readonly localRepositoryId: string };

export const localRepositoryListingSchema = v.array(
  v.object({
    id: v.string(),
    identityKey: v.variant("kind", [
      v.object({
        kind: v.literal("github"),
        host: v.string(),
        owner: v.string(),
        repo: v.string(),
      }),
      v.object({ kind: v.literal("local") }),
    ]),
    displayName: v.string(),
    state: v.picklist(["resolved", "missing", "unresolved"]),
    configuredRoot: v.optional(v.string()),
  }),
);

export function localRepositoryQuery(
  target: LocalRepositoryTarget,
): Record<string, string> {
  return "localRepositoryId" in target
    ? { localRepositoryId: target.localRepositoryId }
    : { host: target.host, owner: target.owner, repo: target.repo };
}
