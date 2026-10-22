import * as v from "valibot";
import {
  walkthroughProgressMutationRequestSchema,
  walkthroughSummarySchema,
  walkthroughPageRequestSchema,
  type WalkthroughSummary,
} from "#src/domain/walkthrough-progress";
import type { NarrativeHunk } from "#src/renderer/src/components/narrative-walkthrough-diff";
import {
  success,
  installDesktopDouble,
  type DesktopRoute,
  type DesktopDouble,
} from "./fake-desktop-response";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
type WalkthroughFixtureRoutes = {
  readonly "/v1/reviews/insights/walkthrough/summary": DesktopRoute;
  readonly "/v1/reviews/insights/walkthrough/page": DesktopRoute;
  readonly "/v1/reviews/insights/walkthrough/reading-progress": DesktopRoute;
};
type WalkthroughDesktopFixture = {
  readonly install: (
    routes: Readonly<Record<string, DesktopRoute>>,
  ) => DesktopDouble;
  readonly configure: (workbench: WorkbenchResponse) => void;
};

/** Slot scenarios select page fixtures before mounting; unrelated routes remain explicit. */
export function walkthroughDesktopFixture(): WalkthroughDesktopFixture {
  let pagedRoutes = walkthroughRoutes({
    _tag: "none",
    run: null,
    failure: null,
  });
  return {
    install: (routes) =>
      installDesktopDouble({
        ...Object.fromEntries(
          (
            [
              "/v1/reviews/insights/walkthrough/summary",
              "/v1/reviews/insights/walkthrough/page",
              "/v1/reviews/insights/walkthrough/reading-progress",
            ] as const
          ).map((path) => [
            path,
            (input: Parameters<DesktopRoute>[0]) => {
              const route = pagedRoutes[path];
              if (route === undefined)
                throw new Error("Missing Walkthrough fixture route");
              return route(input);
            },
          ]),
        ),
        ...routes,
      }),
    configure: (workbench) => {
      const summary = workbench.insights.walkthrough.retained?.value;
      pagedRoutes = walkthroughRoutes(
        summary === undefined
          ? { _tag: "none", run: null, failure: null }
          : {
              ...summary,
              reviewedCount:
                workbench.insights.walkthrough.progress?.reviewedSectionIds
                  .length ?? summary.reviewedCount,
            },
      );
    },
  };
}

/** A strictly parsed published summary, with no section or patch arrays. */
export function walkthroughSummary(): Extract<
  WalkthroughSummary,
  { _tag: "ready" }
> {
  return v.parse(walkthroughSummarySchema.options[1], {
    _tag: "ready",
    run: null,
    failure: null,
    runId: "walkthrough-1",
    sessionId: "session-a",
    revision: {
      baseSha: "0".repeat(40),
      headSha: "a".repeat(40),
      patchHash: "b".repeat(64),
    },
    digest: "a".repeat(64),
    generatedAt: "2026-08-01T00:00:00.000Z",
    provenance: { provider: "pi", model: "test-model", language: "en" },
    title: "Fixture walkthrough",
    focus: "Read the fixture walkthrough.",
    chapters: 1,
    sections: 1,
    hunks: 0,
    citedHunks: 0,
    uncited: 0,
    completeness: {
      knownOmittedChecks: 0,
      knownOmittedThreads: 0,
      knownOmittedRules: 0,
      upstreamCompleteness: "complete",
    },
    progressVersion: 0,
    currentSectionId: null,
    reviewedCount: 0,
  });
}

/** Bounded route fixtures for the existing one-section reader scenarios. */
export function walkthroughRoutes(
  summary: WalkthroughSummary,
  hunks: ReadonlyArray<NarrativeHunk> = [],
): WalkthroughFixtureRoutes {
  const chapter = { id: "c1", title: "Fixture chapter" };
  let reviewed = summary._tag === "ready" && summary.reviewedCount > 0;
  let version = summary._tag === "ready" ? summary.progressVersion : 0;
  return {
    "/v1/reviews/insights/walkthrough/summary": () =>
      success(
        summary._tag === "none"
          ? summary
          : {
              ...summary,
              progressVersion: version,
              reviewedCount: reviewed ? 1 : 0,
            },
      ),
    "/v1/reviews/insights/walkthrough/reading-progress": (input) => {
      const parsed = v.parse(
        v.object({
          mutation: walkthroughProgressMutationRequestSchema.entries.mutation,
        }),
        input.body,
      );
      if (parsed.mutation.action === "set_reviewed")
        reviewed = parsed.mutation.value;
      return success({ version: ++version });
    },
    "/v1/reviews/insights/walkthrough/page": (input) => {
      const { page } = v.parse(
        v.object({ page: walkthroughPageRequestSchema.entries.page }),
        input.body,
      );
      switch (page.kind) {
        case "navigation":
          return success({
            kind: "navigation",
            items: [
              {
                sectionId: "s1",
                ordinal: 0,
                title: "Fixture section",
                chapter,
                reviewed,
              },
            ],
            previous: null,
            next: null,
          });
        case "section":
          return success({
            kind: "section",
            sectionId: "s1",
            ordinal: 0,
            title: "Fixture section",
            prose: "The retained walkthrough is ready to read.",
            chapter,
            citationCount: hunks.length,
            previous: null,
            next: null,
            reviewed,
            navigationCursor: null,
          });
        case "citations":
          return success({
            kind: "citations",
            sectionId: "s1",
            items: hunks.map((hunk) => ({
              hunkId: hunk.id,
              path: { text: hunk.path, next: null },
              oldStart: hunk.oldStart,
              oldLines: hunk.oldLines,
              newStart: hunk.newStart,
              newLines: hunk.newLines,
            })),
            previous: null,
            next: null,
          });
        case "hunk_text": {
          const hunk = hunks.find((item) => item.id === page.hunkId);
          if (hunk === undefined)
            throw new Error("Missing captured fixture hunk");
          return success({
            kind: "hunk_text",
            text: hunk[page.field],
            next: null,
          });
        }
        case "uncited":
          return success({ kind: "uncited", items: [], next: null });
      }
    },
  };
}
