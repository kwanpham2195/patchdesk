import type { JsonSchema } from "@valibot/to-json-schema";
import { describe, expect, it } from "vitest";

import { parseBriefOutput } from "../../src/domain/brief";
import { parseModelReviewResult } from "../../src/domain/review-result";
import {
  analysisCodexOutputSchema,
  briefCodexOutputSchema,
  parseCodexStrictResult,
  walkthroughCodexOutputSchema,
} from "../../src/services/codex-output-schema";

type SchemaNode = JsonSchema["items"];

/** Every schema node reachable through properties, items, and anyOf. */
function schemaNodes(node: SchemaNode): Array<JsonSchema> {
  if (node === undefined || node === true || node === false) return [];
  if (Array.isArray(node)) return node.flatMap(schemaNodes);
  return [
    node,
    ...Object.values(node.properties ?? {}).flatMap(schemaNodes),
    ...schemaNodes(node.items),
    ...(node.anyOf ?? []).flatMap(schemaNodes),
  ];
}

describe("Codex output schemas", () => {
  it.each([
    ["Brief", briefCodexOutputSchema],
    ["Analysis", analysisCodexOutputSchema],
    ["Walkthrough", walkthroughCodexOutputSchema],
  ])(
    "closes every object in the %s schema and requires every property, as Codex strict mode demands",
    (_type, schema) => {
      const nodes = schemaNodes(schema);
      const objects = nodes.filter((node) => node.type === "object");
      expect(objects.length).toBeGreaterThan(0);
      for (const object of objects) {
        expect(object.additionalProperties).toBe(false);
        expect(object.required).toEqual(Object.keys(object.properties ?? {}));
      }
      for (const node of nodes) {
        expect(node).not.toHaveProperty("not");
        if (node.const !== undefined) expect(node.type).toBeDefined();
      }
    },
  );

  it("accepts a Brief that Codex returned with null optional fields once the nulls are mapped back", () => {
    const codexResult = {
      ownership: null,
      startHere: {
        lead: "Read a.ts first.",
        order: [{ path: "a.ts", why: null }],
      },
      flow: [
        {
          kind: "call_tree",
          title: "run",
          nodes: [
            {
              label: "run()",
              change: "added",
              citations: ["h1"],
              children: null,
            },
          ],
        },
      ],
      reachSymbols: null,
    };
    expect(parseBriefOutput(codexResult)._tag).toBe("err");

    const parsed = parseBriefOutput(parseCodexStrictResult(codexResult));

    expect(parsed).toMatchObject({
      _tag: "ok",
      value: {
        startHere: { order: [{ path: "a.ts" }] },
        flow: [{ nodes: [{ label: "run()", citations: ["h1"] }] }],
      },
    });
    expect(parsed._tag === "ok" && parsed.value).not.toHaveProperty(
      "ownership",
    );
  });

  it("accepts an Analysis that Codex returned with null optional fields once the nulls are mapped back", () => {
    const codexResult = {
      changeSummary: "Adds a line to a.ts.",
      verdict: "comment",
      summary: "One minor note.",
      findings: [
        {
          id: "F1",
          severity: "P3",
          title: "Name the added value",
          file: "a.ts",
          lineStart: 2,
          lineEnd: null,
          diffSide: "new",
          explanation: "The added line has no name.",
          suggestedComment: null,
          confidence: "medium",
          category: null,
          affectedScenario: null,
          whyItMatters: null,
          suggestedReplacement: null,
        },
      ],
      validationPlan: [],
      assumptions: [],
      coverage: null,
      overallConfidence: "high",
      unresolvedItems: null,
      callouts: [
        {
          category: "configuration",
          title: "New setting",
          detail: "A setting is read.",
          path: null,
        },
      ],
    };
    expect(parseModelReviewResult(codexResult)._tag).toBe("err");

    const parsed = parseModelReviewResult(parseCodexStrictResult(codexResult));

    expect(parsed).toMatchObject({
      _tag: "ok",
      value: {
        overallConfidence: "high",
        findings: [{ id: "F1", file: "a.ts", lineStart: 2 }],
        callouts: [{ category: "configuration" }],
      },
    });
    expect(parsed._tag === "ok" && parsed.value).not.toHaveProperty("coverage");
  });
});
