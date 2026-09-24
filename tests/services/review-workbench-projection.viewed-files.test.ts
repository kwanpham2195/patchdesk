import { describe, expect, it } from "vitest";

import { err, ok } from "../../src/domain/result";
import {
  at,
  fixture,
  profileId,
  sessionId,
  snapshot,
} from "./review-workbench-projection-fixture";

const input = {
  profileId,
  sessionId,
  snapshot,
  refreshedAt: at,
  freshness: { _tag: "Fresh" },
} as const;

describe("ReviewWorkbenchProjectionService Viewed marks", () => {
  it("projects the Viewed marks stored for the represented session", async () => {
    const value = fixture();
    value.viewedFiles.load.mockResolvedValueOnce(
      // SAFETY: a plain repository-relative path satisfies RepoRelativePath's runtime shape.
      ok(["src/a.ts"]) as never,
    );

    const result = await value.service.loadRepresented(input);

    expect(value.viewedFiles.load).toHaveBeenCalledWith(profileId, sessionId);
    expect(result).toMatchObject({
      _tag: "ok",
      value: { viewedPaths: ["src/a.ts"] },
    });
  });

  it("still opens the Review when the Viewed marks cannot be read", async () => {
    const value = fixture();
    value.viewedFiles.load.mockResolvedValueOnce(
      // SAFETY: this mock value matches the store's failed load result.
      err({ _tag: "StorageFailure", operation: "read", reason: "io" }) as never,
    );

    const result = await value.service.loadRepresented(input);

    expect(result._tag).toBe("ok");
    expect(result._tag === "ok" && "viewedPaths" in result.value).toBe(false);
  });
});
