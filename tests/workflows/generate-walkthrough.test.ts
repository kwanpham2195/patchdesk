import { writeFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import { prepareWalkthroughInputs } from "#src/adapters/storage/walkthrough-preparation-job";
import { GUIDE_MAX_PATCH_BYTES } from "#src/domain/guide-preparation";
import {
  insightArtifactIndexDescriptorSchema,
  insightArtifactReferenceSchema,
} from "#src/domain/insight-artifact-scalars";
import {
  walkthroughInputSchemas,
  walkthroughPayloadSchema,
  type WalkthroughToolCall,
} from "#src/domain/walkthrough-protocol";
import { WalkthroughBuild } from "#src/domain/walkthrough-result-records";
import { walkthroughInputLimitDiagnostic } from "#src/domain/walkthrough-input-diagnostic";
import { insightEvidenceReferenceSchema } from "#src/services/insight-evidence-reference";
import { composeWalkthroughSessionPrompt } from "#src/services/walkthrough-session-prompt";
import { readBoundedArtifact } from "#src/services/walkthrough-artifact-reader";
import {
  cleanupRoots,
  fixture,
  headSha,
  baseSha,
  profileId,
  must,
} from "#tests/services/insight-run-fixture";
import { ok } from "#src/domain/result";

afterEach(cleanupRoots);
const reference = v.parse(
  insightEvidenceReferenceSchema,
  JSON.parse(
    '{"identity":{"profileId":"profile","reviewId":"github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa","sessionId":"github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__0123456789ab","runId":"insight-walkthrough-1-aaaaaaaaaaaa-review","type":"walkthrough","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","patchHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","intentHash":null},"bundleId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","directory":"/fixture","entryPageId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd-p1","pages":[],"sources":[],"manifest":{"sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","bytes":2}}',
  ),
);
const begin = {
  opId: "begin",
  title: "Recovery",
  focus: "Follow the recovery decision.",
};
const section = {
  opId: "section",
  chapterId: "c1",
  title: "One action",
  prose: "The projection selects one action.",
};

type WalkthroughInputFixture = v.InferInput<
  (typeof walkthroughInputSchemas)[keyof typeof walkthroughInputSchemas]
>;

function diagnostic(
  tool: keyof typeof walkthroughInputSchemas,
  input: WalkthroughInputFixture,
) {
  const parsed = v.safeParse(walkthroughInputSchemas[tool], input);
  return parsed.success
    ? undefined
    : walkthroughInputLimitDiagnostic(parsed.issues);
}

function orderedPath() {
  const build = new WalkthroughBuild(
    new Set(Array.from({ length: 34 }, (_, at) => `h${at + 1}`)),
  );
  const receipts = v.parse(insightArtifactIndexDescriptorSchema, {
    root: { hash: "a".repeat(64), bytes: 1 },
    count: 0,
  });
  let sequence = 0;
  const apply = (call: {
    readonly tool: WalkthroughToolCall["tool"];
    readonly input: WalkthroughInputFixture;
  }) =>
    build.apply(
      v.parse(walkthroughPayloadSchema, {
        kind: call.tool,
        ...call.input,
        runId: reference.identity.runId,
        generation: 0,
        cancelEpoch: 0,
      }),
      { sequence: ++sequence, receipts },
    );
  must(apply({ tool: "begin_walkthrough", input: begin }));
  for (let chapter = 1; chapter <= 2; chapter++) {
    expect(
      must(
        apply({
          tool: "open_chapter",
          input: { opId: `chapter-${chapter}`, title: `Chapter ${chapter}` },
        }),
      ),
    ).toEqual({ chapterId: `c${chapter}` });
    for (let offset = 1; offset <= 17; offset++) {
      const at = (chapter - 1) * 17 + offset;
      expect(
        must(
          apply({
            tool: "open_section",
            input: {
              ...section,
              opId: `section-${at}`,
              chapterId: `c${chapter}`,
            },
          }),
        ),
      ).toEqual({ chapterId: `c${chapter}`, sectionId: `s${at}` });
      must(
        apply({
          tool: "add_citations",
          input: {
            opId: `cite-${at}`,
            sectionId: `s${at}`,
            hunkIds: [`h${at}`],
          },
        }),
      );
    }
  }
  must(apply({ tool: "finish", input: { opId: "finish" } }));
  expect(build.isClosed).toBe(true);
}

async function preparationFixture() {
  const value = await fixture({ invoke: async () => ok({}) });
  return {
    value,
    input: {
      sourceRoot: value.paths.dataDirectory(),
      destinationRoot: value.paths.dataDirectory(),
      sourcePath: value.session.patchPath,
      destinationReview: value.paths.reviewDirectory(
        profileId,
        value.review.id,
      ),
      profileId,
      reviewId: value.review.id,
      sessionId: value.session.id,
      runId: reference.identity.runId,
      headSha,
      baseSha,
      expectedHash: "c".repeat(64),
      contextPath: `${value.paths.reviewDirectory(profileId, value.review.id)}/context.json`,
      contextHash: "d".repeat(64),
      contextBytes: 2,
      binding: v.parse(insightArtifactReferenceSchema, {
        hash: "e".repeat(64),
        bytes: 1,
      }),
    },
  };
}

describe("Walkthrough artifact boundary", () => {
  it("reads a bounded artifact without materializing an oversized file", async () => {
    const { value } = await preparationFixture();
    await writeFile(value.session.patchPath, "0123456789");
    await expect(
      readBoundedArtifact(value.session.patchPath, 10),
    ).resolves.toEqual(ok("0123456789"));
    await expect(
      readBoundedArtifact(value.session.patchPath, 9),
    ).resolves.toEqual({ _tag: "err", error: { reason: "input_too_large" } });
  });
});

describe("Walkthrough operation boundary", () => {
  it(
    "accepts ordered sections beyond the removed aggregate output cap",
    orderedPath,
  );

  it("reports only bounded field counts for oversized generated sections", () => {
    expect(
      diagnostic("open_section", {
        ...section,
        prose: "private prose ".repeat(27),
      }),
    ).toBe("prose_377_gt_320");
    expect(diagnostic("open_section", section)).toBeUndefined();
  });

  it.each([
    [
      "focus",
      "begin_walkthrough",
      { ...begin, focus: "x".repeat(321) },
      "focus_321_gt_320",
    ],
    [
      "chapter title",
      "open_chapter",
      { opId: "chapter", title: "x".repeat(81) },
      "title_81_gt_80",
    ],
    [
      "section title",
      "open_section",
      { ...section, title: "x".repeat(161) },
      "title_161_gt_160",
    ],
    [
      "hunk alias",
      "add_citations",
      { opId: "cite", sectionId: "s1", hunkIds: [`h${"1".repeat(16)}`] },
      "hunkIds.0_17_gt_16",
    ],
  ] as const)(
    "reports the rejected %s limit without field text",
    (_field, tool, input, detail) => {
      expect(diagnostic(tool, input)).toBe(detail);
    },
  );

  it("rejects wrong shapes and extra keys", () => {
    expect(
      v.safeParse(walkthroughInputSchemas.begin_walkthrough, {
        ...begin,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(walkthroughInputSchemas.begin_walkthrough, {
        title: "missing",
      }).success,
    ).toBe(false);
  });

  it("rejects oversized prose and invalid aliases without an aggregate section cap", () => {
    expect(
      v.safeParse(walkthroughInputSchemas.open_section, {
        ...section,
        prose: "x".repeat(4001),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(walkthroughInputSchemas.add_citations, {
        opId: "cite",
        sectionId: "s1",
        hunkIds: ["h12345678901234567"],
      }).success,
    ).toBe(false);
    orderedPath();
  });

  it("bounds new prose and focus to the concise limit", () => {
    expect(
      v.safeParse(walkthroughInputSchemas.open_section, {
        ...section,
        prose: "x".repeat(320),
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(walkthroughInputSchemas.begin_walkthrough, {
        ...begin,
        focus: "x".repeat(320),
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(walkthroughInputSchemas.open_section, {
        ...section,
        prose: "x".repeat(321),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(walkthroughInputSchemas.begin_walkthrough, {
        ...begin,
        focus: "x".repeat(321),
      }).success,
    ).toBe(false);
  });
});

describe("Walkthrough prompt and preparation", () => {
  it("uses captured evidence, plain-text section rules, and no write instructions", () => {
    const prompt = composeWalkthroughSessionPrompt(reference, "en");
    expect(prompt).toContain('BCP 47 tag "en"');
    expect(prompt).toContain("Do not translate technical terms");
    expect(prompt).toContain("Use short, direct sentences in the active voice");
    expect(prompt).toContain("Do not narrate the patch file by file");
    expect(prompt).toContain("Use no Markdown");
    expect(prompt).toContain(
      "State what the patch does, never why it was made",
    );
    expect(prompt).toContain("EVIDENCE ENTRY:");
    expect(prompt).toContain("Call finish");
    expect(prompt).not.toContain("submit_patchdesk_result");
    expect(prompt).not.toContain("at most 36");
    expect(prompt).toContain("paths need not be repeated in the prose");
  });

  it("offers a useful reading path without size-driven targets for a large patch", () => {
    const prompt = composeWalkthroughSessionPrompt(reference, "vi");
    expect(prompt).toContain(
      "Use as many distinct, useful sections as the change needs",
    );
    expect(prompt).toContain("Uncited hunks are not explained");
    expect(prompt).not.toContain("aim for");
    expect(prompt).not.toContain("at most 36");
    expect(prompt).not.toContain("h952");
  });

  it("rejects an oversized artifact before composing model input", async () => {
    const { value, input } = await preparationFixture();
    await writeFile(
      value.session.patchPath,
      Buffer.alloc(GUIDE_MAX_PATCH_BYTES + 1, 0x78),
    );
    const result = await prepareWalkthroughInputs(input);
    expect(result).toMatchObject({
      _tag: "err",
      error: { reason: "too_large" },
    });
  });

  it("names an artifact it could not read at all", async () => {
    const { value, input } = await preparationFixture();
    await rm(value.session.patchPath);
    expect(await prepareWalkthroughInputs(input)).toMatchObject({
      _tag: "err",
    });
  });
});
