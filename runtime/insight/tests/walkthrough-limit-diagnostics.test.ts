import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { insightArtifactRunIdSchema } from "#app/domain/insight-artifact-scalars";
import { createWalkthroughSessionTools } from "#runtime/src/walkthrough-session-tools";

describe("Walkthrough child input diagnostics", () => {
  it("returns field counts without generated prose when Pi rejects a tool submission", async () => {
    const tools = createWalkthroughSessionTools(
      {
        runId: v.parse(
          insightArtifactRunIdSchema,
          "insight-walkthrough-1-aaaaaaaaaaaa-review",
        ),
        generation: 0,
        cancelEpoch: 0,
        connection: "test-connection",
      },
      {
        call: async () => {
          throw new Error("Rejected fields must not reach the app");
        },
      },
      { finished: false, halted: false, unconfirmed: false },
      () => undefined,
    );
    const tool = tools.find((candidate) => candidate.name === "open_section");
    if (tool === undefined) throw new Error("Missing section tool");
    const result = tool.execute("call-1", {
      opId: "section-1",
      chapterId: "c1",
      title: "One change",
      prose: "private prose ".repeat(27),
    });
    await expect(result).rejects.toThrow("prose_377_gt_320");
    await expect(result).rejects.not.toThrow("private prose");
  });
});
