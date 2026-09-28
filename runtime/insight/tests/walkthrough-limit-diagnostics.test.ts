import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { runPatchdeskChild } from "../src/patchdesk-insight-runner";

describe("Walkthrough child output diagnostics", () => {
  it("returns field counts without generated prose when Pi rejects a tool submission", async () => {
    const provider = fauxProvider({
      provider: "faux",
      models: [{ id: "test" }],
    });
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("submit_patchdesk_result", {
          citationVersion: 2,
          title: "Walkthrough",
          focus: "Read the change.",
          chapters: [
            {
              title: "Review",
              sections: [
                {
                  title: "One change",
                  prose: "private prose ".repeat(27),
                  hunkIds: Array.from({ length: 127 }, () => "h1"),
                },
              ],
            },
          ],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("Unable to submit a valid result.")),
    ]);
    const result = await runPatchdeskChild(
      {
        type: "walkthrough",
        input: {
          profileId: "profile",
          sessionId: "session",
          contextPath: "/immutable/context",
          patchPath: "/immutable/patch",
          model: "faux/test",
          reasoning: "low",
          prompt: "Submit one result.",
        },
      },
      { providers: [provider.provider] },
    );
    expect(result).toEqual({
      ok: false,
      reason: "invalid_result",
      detail:
        "walkthrough_chapters[0].sections[0].prose_378_gt_320,chapters[0].sections[0].hunkIds_127_gt_32",
    });
    if (!result.ok) expect(result.detail).not.toContain("private prose");
  });
});
