import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { ProfileStore } from "#src/adapters/storage/profile-store";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { WalkthroughProgressStore } from "#src/adapters/storage/walkthrough-progress-store";
import type { NativeExplanationProducer } from "#src/services/explanation-producer";
import { WalkthroughResultReader } from "#src/services/walkthrough-result-reader";
import { WalkthroughProgressService } from "#src/services/walkthrough-result-progress";
import { WalkthroughPageService } from "#src/services/walkthrough-result-pages";
import { walkthroughChildFrameSchema } from "#src/domain/walkthrough-protocol";
import type { WalkthroughPage } from "#src/domain/walkthrough-progress";

import { cleanupRoots, fixture, must, profileId } from "./insight-run-fixture";

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
    let producer:
      | Pick<NativeExplanationProducer, "invokeWalkthroughSession">
      | undefined;
    const value = await fixture(
      {
        invoke: async () => {
          throw new Error("Walkthrough must not use whole-result dispatch");
        },
      },
      {
        walkthroughInvoker: {
          invokeWalkthroughSession: async (input) => {
            if (producer === undefined)
              throw new Error("Missing fixture producer");
            return producer.invokeWalkthroughSession(input);
          },
        },
      },
    );
    await writeFile(value.session.patchPath, patch);
    must(
      await new ProfileStore(value.paths).save({
        id: profileId,
        label: "Fixture",
        schemaVersion: 1 as const,
        localRepositoryCatalogGeneration:
          "12345678-1234-4234-8234-123456789abc",
        github: {
          kind: "connected" as const,
          host: "github.com",
          account: "fixture",
        },

        rulePaths: [],
        repos: [],
      }),
    );
    try {
      producer = {
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
            const outcome = await input.tool(
              v.parse(walkthroughChildFrameSchema, {
                kind: "tool",
                ...input.identity,
                correlation: ++correlation,
                call,
              }).call,
            );
            expect(outcome.status).toBe("receipt");
          }
          return { _tag: "finished" };
        },
      };
      const started = must(
        await value.coordinator.start({
          profileId,
          reviewId: value.review.id,
          type: "walkthrough",
          provider: "codex-cli-account",
          model: "model",
          language: "en",
          reasoning: "medium",
        }),
      );
      expect(started.status).toBe("queued");
      await vi.waitFor(
        async () => {
          expect(
            await value.coordinator.observe({
              profileId,
              reviewId: value.review.id,
              type: "walkthrough",
              runId: started.runId,
            }),
          ).toMatchObject({ _tag: "ok", value: { status: "completed" } });
        },
        { timeout: 110_000, interval: 100 },
      );
      if (value.resources === undefined)
        throw new Error("Missing fixture resources");
      const reader = new WalkthroughResultReader(
        value.paths,
        value.resources.uiReader,
      );
      const artifacts = new InsightArtifactStore(
        value.paths,
        value.resources.uiReader,
      );
      const progress = new WalkthroughProgressService(
        new WalkthroughProgressStore(
          value.paths,
          artifacts,
          value.resources.uiReader,
        ),
        reader,
        value.operations,
        value.reviews,
      );
      const pages = new WalkthroughPageService(reader, progress);
      const summaries = await Promise.all([
        pages.summary(profileId, value.review.id),
        pages.summary(profileId, value.review.id),
      ]);
      const summary = must(summaries[0]);
      expect(must(summaries[1])).toEqual(summary);
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
      // Regression for #821: the reader failed on a published PR-scale Walkthrough.
      const initialPages = await Promise.all([
        pages.page({
          profileId,
          reviewId: value.review.id,
          digest: summary.digest,
          page: { kind: "navigation", cursor: null },
        }),
        pages.page({
          profileId,
          reviewId: value.review.id,
          digest: summary.digest,
          page: { kind: "section", sectionId: "s1" },
        }),
      ]);
      expect(must(initialPages[0]).kind).toBe("navigation");
      expect(must(initialPages[1]).kind).toBe("section");
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
      await value.resources?.dispose();
    }
    // Durable capture and independent replay replace the former in-memory whole-result normalization.
  }, 120_000);
});
