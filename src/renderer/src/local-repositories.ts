import * as v from "valibot";
import type { RepositoryIdentity } from "#src/domain/repository-identity";

export type LocalRepositoryTarget =
  | RepositoryIdentity
  | { readonly localRepositoryId: string };

export const localRepositoryListingSchema = v.array(
  v.object({
    id: v.string(),
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
