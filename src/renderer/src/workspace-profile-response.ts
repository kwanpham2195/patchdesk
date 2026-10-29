import * as v from "valibot";

export const workspaceProfileResponseSchema = v.pipe(
  v.object({
    id: v.string(),
    label: v.string(),
    github: v.variant("kind", [
      v.object({ kind: v.literal("disconnected") }),
      v.object({
        kind: v.literal("connected"),
        host: v.string(),
        account: v.string(),
      }),
    ]),
    rulePaths: v.optional(v.array(v.string())),
    repos: v.optional(
      v.array(
        v.object({
          host: v.string(),
          owner: v.string(),
          repo: v.string(),
          localPath: v.optional(v.string()),
        }),
      ),
    ),
  }),
  v.transform((profile) => ({
    ...profile,
    githubHost: profile.github.kind === "connected" ? profile.github.host : "",
    ghAccount:
      profile.github.kind === "connected" ? profile.github.account : "",
  })),
);

export const parseWorkspaceProfiles = v.parser(
  v.array(workspaceProfileResponseSchema),
);
