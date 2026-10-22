import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import { ProfileStore } from "#src/adapters/storage/profile-store";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { WalkthroughProgressStore } from "#src/adapters/storage/walkthrough-progress-store";
import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { WalkthroughGenerationService } from "#src/services/walkthrough-generation-service";
import { ExplanationPreparationService } from "#src/services/explanation-preparation-service";
import { WalkthroughResultReader } from "#src/services/walkthrough-result-reader";
import { WalkthroughProgressService } from "#src/services/walkthrough-result-progress";
import { WalkthroughPageService } from "#src/services/walkthrough-result-pages";
import { createInProcessInsightResourceBundle } from "#src/services/insight-resource-bundle";
import { contentHash } from "#src/services/review-artifact-hash";
import { walkthroughChildFrameSchema } from "#src/domain/walkthrough-protocol";
import type { WalkthroughPage } from "#src/domain/walkthrough-progress";

import { ok } from "#src/domain/result";
import {
  cleanupRoots,
  fixture,
  must,
  now,
  headSha,
  baseSha,
  contextPackFixture,
  profileId,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

describe("large Walkthrough retention", () => {
  it("retains a bounded reading path and every uncited hunk for a 952-hunk patch", async () => {
    const patch =
      Array.from({ length: 200 }, (_, fileIndex) => {
        const path = `src/module-${fileIndex + 1}.ts`;
        const hunkCount = fileIndex < 152 ? 5 : 4;
        return [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          ...Array.from({ length: hunkCount }, (_, hunkIndex) =>
            [
              `@@ -${hunkIndex},0 +${hunkIndex + 1} @@`,
              `+const value${hunkIndex} = true;`,
            ].join("\n"),
          ),
        ].join("\n");
      }).join("\n") + "\n";
    const chapters = [
      {
        title: "Reading path",
        sections: Array.from({ length: 12 }, (_, sectionIndex) => ({
          title: `Decision ${sectionIndex + 1}`,
          prose: `src/module-${Math.floor((sectionIndex * 2) / 5) + 1}.ts and src/module-${Math.floor((sectionIndex * 2 + 1) / 5) + 1}.ts contain representative changes.`,
          hunkIds: [`h${sectionIndex * 2 + 1}`, `h${sectionIndex * 2 + 2}`],
        })),
      },
    ];
    const value = await fixture({ invoke: async () => ok({}) });
    await writeFile(value.session.patchPath, patch);
    must(
      await new ProfileStore(value.paths).save({
        id: profileId,
        label: "Fixture",
        githubHost: "github.com",
        ghAccount: "fixture",
        rulePaths: [],
        repos: [],
      }),
    );
    const resources = createInProcessInsightResourceBundle();
    try {
      const service = new WalkthroughGenerationService(
        value.paths,
        new ExplanationPreparationService(
          value.paths,
          value.paths,
          resources,
          value.operations,
          contextPackFixture(value.paths).service,
          () => now,
          value.slots,
        ),
        value.slots,
        resources,
        {
          async invokeWalkthroughSession(input) {
            let correlation = 0;
            const calls = [
              {
                tool: "begin_walkthrough",
                input: {
                  opId: "begin",
                  title: "Large patch reading path",
                  focus: "Follow representative changes.",
                },
              },
              {
                tool: "open_chapter",
                input: { opId: "chapter", title: "Reading path" },
              },
              ...chapters
                .flatMap((chapter) => chapter.sections)
                .flatMap((section, index) => [
                  {
                    tool: "open_section",
                    input: {
                      opId: `section-${index}`,
                      chapterId: "c1",
                      title: section.title,
                      prose: section.prose,
                    },
                  },
                  {
                    tool: "add_citations",
                    input: {
                      opId: `cite-${index}`,
                      sectionId: `s${index + 1}`,
                      hunkIds: section.hunkIds,
                    },
                  },
                ]),
              { tool: "finish", input: { opId: "finish" } },
            ];
            for (const call of calls) {
              const outcome = await input.handler(
                v.parse(walkthroughChildFrameSchema, {
                  kind: "tool",
                  ...input.identity,
                  correlation: ++correlation,
                  call,
                }),
              );
              expect(outcome.status).toBe("receipt");
            }
            return { _tag: "finished" };
          },
        },
        () => now,
      );
      const started = must(
        await service.start({
          profileId,
          reviewId: value.review.id,
          revision: value.review.updatedAt,
          sessionId: value.session.id,
          expectedHash: await contentHash(value.session.patchPath),
          headSha,
          baseSha,
          selection: {
            provider: "pi",
            model: "model",
            reasoning: "medium",
            language: "en",
          },
          reasoning: "medium",
        }),
      );
      await started.completion;
      const reader = new WalkthroughResultReader(
        value.paths,
        readBoundedInsightArtifactFile,
      );
      const artifacts = new InsightArtifactStore(
        value.paths,
        readBoundedInsightArtifactFile,
      );
      const progress = new WalkthroughProgressService(
        new WalkthroughProgressStore(
          value.paths,
          artifacts,
          readBoundedInsightArtifactFile,
        ),
        reader,
        value.operations,
        value.reviews,
      );
      const pages = new WalkthroughPageService(reader, progress);
      const summary = must(await pages.summary(profileId, value.review.id));
      expect(summary).toMatchObject({
        _tag: "ready",
        chapters: 1,
        sections: 12,
        hunks: 952,
        citedHunks: 24,
        uncited: 928,
      });
      if (summary._tag !== "ready")
        throw new Error("Expected published Walkthrough");
      const cited: string[] = [];
      for (let section = 1; section <= summary.sections; section += 1) {
        const page: WalkthroughPage = must(
          await pages.page({
            profileId,
            reviewId: value.review.id,
            digest: summary.digest,
            page: { kind: "citations", sectionId: `s${section}`, cursor: null },
          }),
        );
        if (page.kind !== "citations")
          throw new Error("Expected citations page");
        cited.push(...page.items.map((item) => item.hunkId));
      }
      expect(cited).toHaveLength(24);
      expect(cited).toContain("h24");
      const uncited: string[] = [];
      let cursor: string | null = null;
      do {
        const page: WalkthroughPage = must(
          await pages.page({
            profileId,
            reviewId: value.review.id,
            digest: summary.digest,
            page: { kind: "uncited", cursor },
          }),
        );
        if (page.kind !== "uncited") throw new Error("Expected uncited page");
        uncited.push(...page.items.map((item) => item.hunkId));
        cursor = page.next;
      } while (cursor !== null);
      expect(uncited).toHaveLength(928);
      expect(uncited).toContain("h25");
      expect(uncited).toContain("h952");
    } finally {
      await resources.dispose();
    }
    // Durable capture and independent replay replace the former in-memory whole-result normalization.
  }, 180_000);
});
