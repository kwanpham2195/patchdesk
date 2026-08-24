import { describe, expect, it, vi } from "vitest";

import { err, ok } from "../../src/domain/result";
import { CallFlowService } from "../../src/services/call-flow-service";

const profileId = "cfw";
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca";
const baseSha = "b".repeat(40);
const headSha = "a".repeat(40);

describe("CallFlowService", () => {
  it("retries an unavailable child analysis instead of caching the failure", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(err({ reason: "timed_out" as const }))
      .mockResolvedValueOnce(
        ok({
          state: "unsupported" as const,
          snapshot: { sessionId, baseSha, headSha },
          languages: {
            analyzed: [],
            available: 4 as const,
            skippedChangedFiles: 1,
          },
        }),
      );
    const service = new CallFlowService(
      {
        load: vi.fn(async () =>
          // SAFETY: the service reads only this fixture's immutable Review identifiers and worktree path.
          ok({
            id: sessionId,
            key: { baseSha, headSha },
            worktree: { path: "/tmp/patchdesk-call-flow", headSha },
          } as never),
        ),
      },
      { invoke },
    );

    const first = await service.load({ profileId, sessionId });
    const second = await service.load({ profileId, sessionId });

    expect(first).toEqual(ok({ state: "unavailable", reason: "timed_out" }));
    expect(second._tag).toBe("ok");
    if (second._tag === "ok") expect(second.value.state).toBe("unsupported");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
