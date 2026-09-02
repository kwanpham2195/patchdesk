import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import * as v from "valibot";

import {
  briefResultSchema,
  jsonSchemaFor,
  modelReviewResultSchema,
  walkthroughResultSchema,
} from "../src/patchdesk-insight-agent";
import { runPatchdeskChild } from "../src/patchdesk-insight-runner";

/**
 * Runs one candidate submission through the same validator Pi's agent loop
 * applies to tool arguments, against the same projected JSON Schema the tool
 * declares, so the test measures the projection rather than a copy of it.
 */
function acceptedByProjection(
  schema: Parameters<typeof jsonSchemaFor>[0],
  value:
    | v.InferInput<typeof walkthroughResultSchema>
    | v.InferInput<typeof modelReviewResultSchema>
    | v.InferInput<typeof briefResultSchema>,
): boolean {
  try {
    validateToolArguments(
      {
        name: "submit_patchdesk_result",
        description: "Submit the one complete Patchdesk result.",
        parameters: jsonSchemaFor(schema),
      },
      {
        type: "toolCall",
        id: "call-1",
        name: "submit_patchdesk_result",
        arguments: structuredClone(value),
      },
    );
    return true;
  } catch {
    return false;
  }
}

const minimalWalkthrough = {
  citationVersion: 2 as const,
  title: "Walkthrough",
  focus: "The patch adds a bounded review path.",
  chapters: [
    {
      title: "Review",
      sections: [
        {
          title: "One change",
          prose: "The child accepts one result.",
          hunkIds: ["h1"],
        },
      ],
    },
  ],
};
const minimalAnalysis = {
  changeSummary: "One change.",
  verdict: "approve" as const,
  summary: "No findings.",
  findings: [],
  validationPlan: [],
  assumptions: [],
};
const minimalBrief = { reachSymbols: ["runPatchdeskChild"] };

/** 34 sections across two chapters: every per-array bound holds, the aggregate cap does not. */
const overCapWalkthrough = {
  ...minimalWalkthrough,
  chapters: Array.from({ length: 2 }, (_chapter, chapterIndex) => ({
    title: `Chapter ${chapterIndex + 1}`,
    sections: Array.from({ length: 17 }, (_section, sectionIndex) => ({
      title: `Section ${sectionIndex + 1}`,
      prose: "The child accepts one result.",
      hunkIds: ["h1"],
    })),
  })),
};

describe("result schema projection", () => {
  it("round-trips a minimal valid result for all three insights", () => {
    for (const [schema, value] of [
      [walkthroughResultSchema, minimalWalkthrough],
      [modelReviewResultSchema, minimalAnalysis],
      [briefResultSchema, minimalBrief],
    ] as const) {
      expect(v.safeParse(schema, value).success).toBe(true);
      expect(acceptedByProjection(schema, value)).toBe(true);
    }
  });

  it("drops every trace of the walkthrough section cap from the projection", () => {
    const projected: object = jsonSchemaFor(walkthroughResultSchema);
    expect(JSON.stringify(projected)).not.toContain("aggregate section limit");
    // A projected `v.check` would have to survive as a wrapper around the
    // object schema; the projection is the bare object instead.
    expect(projected).toMatchObject({ type: "object" });
    expect(Object.keys(projected)).not.toEqual(
      expect.arrayContaining(["allOf", "anyOf", "oneOf", "not"]),
    );
  });

  it("accepts an over-cap walkthrough through the projection that Valibot rejects", () => {
    expect(
      acceptedByProjection(walkthroughResultSchema, overCapWalkthrough),
    ).toBe(true);
    const parsed = v.safeParse(walkthroughResultSchema, overCapWalkthrough);
    if (parsed.success) throw new Error("expected the aggregate cap to reject");
    expect(parsed.issues.map((issue) => issue.message)).toContain(
      "Walkthrough output exceeds the aggregate section limit",
    );
  });
});

function walkthroughInvocation() {
  return {
    type: "walkthrough" as const,
    input: {
      profileId: "profile",
      sessionId: "session",
      contextPath: "/immutable/context",
      patchPath: "/immutable/patch",
      model: "faux/test",
      reasoning: "low" as const,
      prompt: "Submit one result.",
    },
  };
}

function fake(responses: ReadonlyArray<FauxResponseStep>) {
  const provider = fauxProvider({ provider: "faux", models: [{ id: "test" }] });
  provider.setResponses([...responses]);
  return provider;
}

/** The text of the newest tool result in a turn's context, as the model reads it. */
function lastToolResultText(messages: ReadonlyArray<Message>): string {
  const results = messages.filter(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );
  const last = results.at(-1);
  if (last === undefined) return "";
  return last.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

describe("rejected submission", () => {
  it("names the broken constraint to the model and records the corrected resubmission", async () => {
    let rejection = "";
    const provider = fake([
      fauxAssistantMessage(
        fauxToolCall("submit_patchdesk_result", overCapWalkthrough),
        { stopReason: "toolUse" },
      ),
      (context) => {
        rejection = lastToolResultText(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("submit_patchdesk_result", minimalWalkthrough),
          { stopReason: "toolUse" },
        );
      },
    ]);
    await expect(
      runPatchdeskChild(walkthroughInvocation(), {
        providers: [provider.provider],
      }),
    ).resolves.toEqual({ ok: true, value: minimalWalkthrough });
    expect(rejection).toContain(
      "The submitted result does not match the Patchdesk result schema",
    );
    expect(rejection).toContain(
      "Walkthrough output exceeds the aggregate section limit",
    );
    expect(provider.state.callCount).toBe(2);
  });
});
