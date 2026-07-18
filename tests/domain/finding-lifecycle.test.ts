import { describe, expect, it } from "vitest";

import {
  parseContentHash,
  parseFindingId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { projectFindingLifecycle } from "../../src/domain/finding-lifecycle";

function must<T, E>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err"; readonly error: E }): T {
  if (result._tag === "err") throw new Error("Expected parsed fixture");
  return result.value;
}

const token = must(parseContentHash("a".repeat(64)));
const priorId = must(parseFindingId("prior-finding"));
const currentId = must(parseFindingId("current-finding"));
const path = must(parseRepoRelativePath("src/service.ts"));
const current = {
  id: currentId,
  severity: "P1" as const,
  title: "Guard duplicate input",
  explanation: "The request must reject repeated IDs.",
  confidence: "high" as const,
  file: path,
  lineStart: 12,
  mappingStatus: "mapped" as const,
};
const prior = {
  token,
  findingId: priorId,
  severity: "P1" as const,
  title: "Guard duplicate input",
  explanation: "The request must reject repeated IDs.",
  file: path,
  wasSubmitted: true,
};

describe("finding lifecycle", () => {
  it("marks missing assessments unverified and never makes them draft comments", () => {
    const result = projectFindingLifecycle({ priorFindings: [prior], assessments: [], currentFindings: [], changedPaths: new Set() });
    expect(result).toEqual({
      _tag: "ok",
      value: [expect.objectContaining({ status: "unverified", draftPostability: "not_applicable" })],
    });
  });

  it("keeps a submitted still-present finding out of a new draft and maps new findings", () => {
    const result = projectFindingLifecycle({
      priorFindings: [prior],
      assessments: [{ priorFindingToken: token, disposition: "still_present", explanation: "The guard is still absent.", currentFindingId: currentId }],
      currentFindings: [current],
      changedPaths: new Set([path]),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: [expect.objectContaining({ status: "still_present", draftPostability: "already_reported" })],
    });
  });

  it("downgrades a resolved claim to unverified when the prior file did not change", () => {
    const result = projectFindingLifecycle({
      priorFindings: [prior],
      assessments: [{ priorFindingToken: token, disposition: "resolved", explanation: "Fixed upstream." }],
      currentFindings: [],
      changedPaths: new Set(),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: [expect.objectContaining({ status: "unverified", evidence: "prior_result" })],
    });
  });

  it("rejects model assessments for an unknown prior token", () => {
    const unknown = must(parseContentHash("b".repeat(64)));
    expect(projectFindingLifecycle({
      priorFindings: [prior],
      assessments: [{ priorFindingToken: unknown, disposition: "unverified", explanation: "Unknown." }],
      currentFindings: [],
      changedPaths: new Set(),
    })).toEqual({ _tag: "err", error: { _tag: "InvalidPriorFindingAssessment", reason: "unknown_token" } });
  });
});
