import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import * as v from "valibot";

import { PatchdeskPaths } from "../../../src/adapters/storage/patchdesk-paths";
import {
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../../src/domain/ids";

import { modelReviewResultSchema } from "../src/patchdesk-insight-agent";
import {
  canonicalizeProductionInvocation,
  runPatchdeskChild,
  writeRejectedResult,
} from "../src/patchdesk-insight-runner";

const blockingFinding = {
  id: "f1",
  severity: "P1" as const,
  title: "The retry loop drops the last error",
  explanation: "The catch block returns before the message is recorded.",
  confidence: "high" as const,
};

/** One P1 finding with the non-blocking verdict the severity rule forbids. */
const mismatched = {
  changeSummary: "One change.",
  verdict: "comment" as const,
  summary: "One blocking finding.",
  findings: [blockingFinding],
  validationPlan: [],
  assumptions: [],
};

const corrected = { ...mismatched, verdict: "request_changes" as const };

const reviewSkillPath = new URL(
  "../../../src/skills/patchdesk-code-review/SKILL.md",
  import.meta.url,
).pathname;

/** Inspectors that always answer, so a test pins the submit tool rather than a budget. */
function benignInspectors() {
  return {
    async listChangedFiles() {
      return { files: ["src/a.ts"] };
    },
    async searchFiles() {
      return { files: [] };
    },
    async readFileRange() {
      return { content: "" };
    },
    async gitShow() {
      return { content: "" };
    },
  };
}

function analysisInvocation() {
  return {
    type: "analysis" as const,
    input: {
      profileId: "profile",
      sessionId: "session",
      contextPath: "/immutable/context",
      reviewInputPath: "/immutable/input",
      patchPath: "/immutable/patch",
      worktreePath: "/immutable/worktree",
      model: "faux/test",
      reasoning: "low" as const,
      prompt: "Inspect then submit one result.",
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

const canonicalSessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__0123456789ab";

function canonicalIdentity() {
  const profile = parseWorkspaceProfileId("profile");
  const session = parseReviewSessionId(canonicalSessionId);
  if (profile._tag === "err" || session._tag === "err")
    throw new Error("fixture identity is invalid");
  return { profileId: profile.value, sessionId: session.value };
}

describe("verdict consistency on the Pi submit tool", () => {
  it("names the required verdict to the model and records the corrected resubmission", async () => {
    let rejection = "";
    const provider = fake([
      fauxAssistantMessage(
        fauxToolCall("submit_patchdesk_result", mismatched),
        { stopReason: "toolUse" },
      ),
      (context) => {
        rejection = lastToolResultText(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("submit_patchdesk_result", corrected),
          { stopReason: "toolUse" },
        );
      },
    ]);
    await expect(
      runPatchdeskChild(analysisInvocation(), {
        providers: [provider.provider],
        inspectors: benignInspectors(),
        skillPath: reviewSkillPath,
      }),
    ).resolves.toEqual({ ok: true, value: corrected });
    expect(rejection).toContain('The submitted verdict "comment"');
    expect(rejection).toContain('require "request_changes"');
    expect(provider.state.callCount).toBe(2);
  });
});

describe("rejected submission on disk", () => {
  it("keeps the raw value and the constraints it broke beside the prepared files", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-rejected-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const { profileId, sessionId } = canonicalIdentity();
      const path = paths.rejectedResultFile(profileId, sessionId);
      const raw = { verdict: "comment", findings: "not an array" };
      const parsed = v.safeParse(modelReviewResultSchema, raw);
      if (parsed.success)
        throw new Error("fixture must fail the result schema");
      await writeRejectedResult(path, raw, parsed.issues);
      const written: unknown = JSON.parse(await readFile(path, "utf8"));
      expect(written).toMatchObject({ value: raw });
      expect(
        v.parse(
          v.object({ issues: v.pipe(v.array(v.unknown()), v.minLength(1)) }),
          written,
        ).issues.length,
      ).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives every production invocation the one rejected-result path", () => {
    const root = join(tmpdir(), "patchdesk-rejected-path");
    const paths = PatchdeskPaths.forTest(root);
    const { profileId, sessionId } = canonicalIdentity();
    const expected = paths.rejectedResultFile(profileId, sessionId);
    const shared = {
      profileId,
      sessionId,
      patchPath: paths.patchFile(profileId, sessionId),
      model: "faux/test",
      reasoning: "low" as const,
    };
    expect(
      canonicalizeProductionInvocation({ type: "brief", input: shared }, paths),
    ).toMatchObject({ rejectedResultPath: expected });
    expect(
      canonicalizeProductionInvocation(
        {
          type: "walkthrough",
          input: {
            ...shared,
            contextPath: paths.preparedContextFile(profileId, sessionId),
          },
        },
        paths,
      ),
    ).toMatchObject({ rejectedResultPath: expected });
    expect(
      canonicalizeProductionInvocation(
        {
          type: "analysis",
          input: {
            ...shared,
            contextPath: paths.preparedContextFile(profileId, sessionId),
            reviewInputPath: paths.preparedReviewInputFile(
              profileId,
              sessionId,
            ),
            worktreePath: paths.worktreeDirectory(profileId, sessionId),
          },
        },
        paths,
      ),
    ).toMatchObject({ rejectedResultPath: expected });
  });
});
