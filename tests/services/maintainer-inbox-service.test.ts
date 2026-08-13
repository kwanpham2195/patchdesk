import { describe, expect, it } from "vitest";

import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";
import { ok } from "../../src/domain/result";

describe("MaintainerInboxService", () => {
  it("uses saved Review identity as the action authority", async () => {
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        listMaintainerPullRequests: async () =>
          ok({
            pullRequests: [
              {
                summary: {
                  ref: {
                    host: "github.com",
                    owner: "centraldigital",
                    repo: "patchdesk",
                    number: 42,
                  },
                  title: "Fixture",
                  author: "other",
                  headSha: "a".repeat(40),
                  baseSha: "b".repeat(40),
                  isOpen: true,
                  isDraft: false,
                  reviewState: "none",
                  mergeability: "mergeable",
                  labels: [],
                  updatedAt: "2026-08-01T00:00:00.000Z",
                },
                checks: { overall: "passing", checks: [] },
              },
            ],
            complete: true,
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );
    await expect(
      service.list({
        id: "cfw",
        ghAccount: "fixture",
        repos: [
          { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
        ],
      } as never),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { rows: [{ recommendedAction: { kind: "run_review" } }] },
    });
  });
});
