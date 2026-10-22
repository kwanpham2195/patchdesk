import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { insightArtifactRunIdSchema } from "#app/domain/insight-artifact-scalars";
import { walkthroughInputSchemas } from "#app/domain/walkthrough-protocol";
import {
  briefResultSchema,
  jsonSchemaFor,
  modelReviewResultSchema,
} from "#runtime/src/patchdesk-insight-agent";
import { createWalkthroughSessionTools } from "#runtime/src/walkthrough-session-tools";

function acceptedByProjection(
  schema: Parameters<typeof jsonSchemaFor>[0],
  value:
    | v.InferInput<typeof walkthroughInputSchemas.open_section>
    | v.InferInput<typeof modelReviewResultSchema>
    | v.InferInput<typeof briefResultSchema>,
): boolean {
  try {
    validateToolArguments(
      {
        name: "tool",
        description: "Patchdesk tool",
        parameters: jsonSchemaFor(schema),
      },
      {
        type: "toolCall",
        id: "call-1",
        name: "tool",
        arguments: JSON.parse(JSON.stringify(value)),
      },
    );
    return true;
  } catch {
    return false;
  }
}

const section = {
  opId: "section-1",
  chapterId: "c1",
  title: "One change",
  prose: "The child accepts one section.",
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

describe("result and operation schema projection", () => {
  it("round-trips a minimal valid result or operation for all three insights", () => {
    for (const [schema, value] of [
      [walkthroughInputSchemas.open_section, section],
      [modelReviewResultSchema, minimalAnalysis],
      [briefResultSchema, minimalBrief],
    ] as const) {
      expect(v.safeParse(schema, value).success).toBe(true);
      expect(acceptedByProjection(schema, value)).toBe(true);
    }
  });

  it("drops every trace of the retired walkthrough section cap from the projection", () => {
    const projected: object = jsonSchemaFor(
      walkthroughInputSchemas.open_section,
    );
    expect(JSON.stringify(projected)).not.toContain("aggregate section limit");
    expect(projected).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(Object.keys(projected)).not.toEqual(
      expect.arrayContaining(["allOf", "anyOf", "oneOf", "not"]),
    );
  });
});

describe("rejected operation", () => {
  it("names the broken constraint to the model and records the corrected resubmission", async () => {
    let accepted = 0;
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
          accepted++;
          return {
            status: "receipt",
            sequence: 1,
            result: { chapterId: "c1", sectionId: "s1" },
          };
        },
      },
      { finished: false, halted: false, unconfirmed: false },
      () => undefined,
    );
    const tool = tools.find((candidate) => candidate.name === "open_section");
    if (tool === undefined) throw new Error("Missing section tool");
    await expect(
      tool.execute("bad", { ...section, prose: "x".repeat(321) }),
    ).rejects.toThrow("prose_321_gt_320");
    expect(accepted).toBe(0);
    await expect(tool.execute("corrected", section)).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            accepted: true,
            sequence: 1,
            chapterId: "c1",
            sectionId: "s1",
          }),
        },
      ],
    });
    expect(accepted).toBe(1);
  });
});
