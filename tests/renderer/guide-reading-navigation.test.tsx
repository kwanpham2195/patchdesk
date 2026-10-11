// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import * as v from "valibot";
import { GuideReader } from "#src/renderer/src/components/guide-reader";
import { useGuideReadingPosition } from "#src/renderer/src/components/guide-reading-position";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import {
  guideReadingContentSchema,
  validateGuideReadingContent,
  type GuideReadingContent,
  type GuideReadingState,
} from "#src/domain/guide-reading-state";
import { parseInsightRunId, parseReviewSessionId } from "#src/domain/ids";
import { must } from "#tests/services/insight-run-fixture";
import { afterEach, describe, expect, it } from "vitest";
import {
  GuideReadingFlushProvider,
  useGuideReadingFlush,
  useGuideReadingCommands,
} from "#src/renderer/src/hooks/use-guide-reading-flush";
import {
  installDesktopDouble,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

describe("Guide position at Others", () => {
  it.each([
    {
      name: "section heading",
      scrollTop: 210,
      anchor: { kind: "file", groupId: "g1", fileId: "f1", offset: 110 },
    },
    {
      name: "file appearance",
      scrollTop: 310,
      anchor: { kind: "file", groupId: "others", fileId: "f2", offset: 10 },
    },
  ] as const)(
    "records valid progress at the Others $name from the actual reader markup",
    async ({ scrollTop, anchor }) => {
      const patchText =
        "diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\ndiff --git a/src/b.ts b/src/b.ts\nold mode 100644\nnew mode 100755\n";
      const guide = must(
        retainGuide(
          {
            groups: [
              {
                title: "Recovery",
                explanation: "Restore pending state.",
                files: [{ fileId: "f1", relevance: "Recovery owner." }],
              },
            ],
          },
          { patchText, inventory: must(buildGuideInventory(patchText)) },
        ),
      );
      render(
        <div role="region" aria-label="Guide viewport" data-guide-viewport>
          <GuideReader guide={guide} />
        </div>,
      );
      const outer = screen.getByRole("region", { name: "Guide viewport" });
      const viewport = screen
        .getByRole("region", { name: "Recovery" })
        .closest<HTMLElement>("[data-guide-viewport]");
      const content = viewport?.querySelector<HTMLDivElement>(":scope > div");
      if (viewport === null || content === null || content === undefined)
        throw new Error("Missing Guide content viewport");
      viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 200);
      const group = screen
        .getByRole("region", { name: "Recovery" })
        .closest("li");
      const firstFile = screen
        .getByRole("button", { name: "File src/a.ts" })
        .closest("li");
      const others = screen.getByRole("region", { name: "Others · 1 file" });
      const otherFile = screen
        .getByRole("button", { name: "File src/b.ts" })
        .closest("li");
      if (group === null || firstFile === null || otherFile === null)
        throw new Error("Missing Guide appearance");
      for (const [node, top] of [
        [group, 0],
        [firstFile, 100],
        [others, 200],
        [otherFile, 300],
      ] as const) {
        node.getBoundingClientRect = () =>
          new DOMRect(0, top - viewport.scrollTop, 800, 100);
      }
      const progress: GuideReadingState = {
        runId: must(
          parseInsightRunId(
            "insight-guide-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
          ),
        ),
        sessionId: must(
          parseReviewSessionId(
            "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
          ),
        ),
        version: 0,
        reviewedGroupIds: ["g1"],
        expandedAppearances: [{ groupId: "others", fileId: "f2" }],
        anchor: { kind: "top" },
      };
      const edits: GuideReadingContent[] = [];
      renderHook(() =>
        useGuideReadingPosition(
          { current: content },
          {
            progress,
            saveFailed: false,
            edit: (edit) => edits.push(edit),
            retry: async () => true,
          },
        ),
      );
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      act(() => {
        outer.scrollTop = 73;
        fireEvent.scroll(outer);
      });
      expect(edits).toHaveLength(0);
      act(() => {
        viewport.scrollTop = scrollTop;
        fireEvent.scroll(viewport);
      });
      expect(outer.scrollTop).toBe(73);
      const recorded = edits.at(-1);
      expect(recorded?.anchor).toEqual(anchor);
      expect(recorded?.reviewedGroupIds).toEqual(["g1"]);
      expect(recorded?.expandedAppearances).toEqual([
        { groupId: "others", fileId: "f2" },
      ]);
      const parsed = v.safeParse(guideReadingContentSchema, recorded);
      expect(parsed.success).toBe(true);
      if (parsed.success)
        expect(validateGuideReadingContent(parsed.output, guide)._tag).toBe(
          "ok",
        );
    },
  );
});

describe("renderer Guide flush lifetime", () => {
  it("acknowledges only after every registered reading queue settles", async () => {
    desktop = installDesktopDouble({});
    const { result, unmount } = renderHook(useGuideReadingFlush, {
      wrapper: GuideReadingFlushProvider,
    });
    let finish: ((saved: boolean) => void) | undefined;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const unregister = result.current.register(() => pending);
    let acknowledged = false;
    const completion = desktop.flushGuideReading().then((saved) => {
      acknowledged = saved;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish?.(true);
    await completion;
    expect(acknowledged).toBe(true);
    unregister();
    expect(await result.current.flush()).toBe(true);
    unmount();
    expect(await desktop.flushGuideReading()).toBe(false);
  });

  it("keeps failed progress registered for a later Retry", async () => {
    desktop = installDesktopDouble({});
    const { result, unmount } = renderHook(useGuideReadingFlush, {
      wrapper: GuideReadingFlushProvider,
    });
    let saved = false;
    const unregister = result.current.register(async () => saved);
    expect(await desktop.flushGuideReading()).toBe(false);
    saved = true;
    expect(await desktop.flushGuideReading()).toBe(true);
    unregister();
    unmount();
  });

  it.each(["", "approved old body"])(
    "refuses newly edited draft text during an awaited save from %s",
    async (initialText) => {
      const double = installDesktopDouble({});
      desktop = double;
      const { result, unmount } = renderHook(useGuideReadingFlush, {
        wrapper: GuideReadingFlushProvider,
      });
      let text = initialText;
      result.current.registerGuard(() => ({
        state: text === "" ? "clear" : "dirty_draft",
        draftIdentity: text,
      }));
      let finish: ((saved: boolean) => void) | undefined;
      let start: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const saving = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      result.current.register(() => {
        start?.();
        return saving;
      });
      const inspected = await double.guideAdmission({
        requestId: "inspect",
        phase: "inspect",
      });
      if (inspected === undefined) throw new Error("No renderer inspection");
      const pending = double.guideAdmission({
        requestId: "admit",
        phase: "admit",
        approvedDraftRevision: inspected.draftRevision,
        approvedRendererId: inspected.rendererId,
      });
      await started;
      text = "new nonempty body";
      finish?.(true);
      const admission = await pending;
      expect(admission?.saved).toBe(false);
      expect(admission?.state).toBe("dirty_draft");
      expect(admission?.draftRevision).not.toBe(inspected.draftRevision);
      expect(JSON.stringify(admission)).not.toContain(text);
      unmount();
    },
  );

  it("refuses approval from a disposed renderer even when its revision number matches", async () => {
    const double = installDesktopDouble({});
    desktop = double;
    const first = renderHook(useGuideReadingFlush, {
      wrapper: GuideReadingFlushProvider,
    });
    const inspected = await double.guideAdmission({
      requestId: "inspect",
      phase: "inspect",
    });
    if (inspected === undefined) throw new Error("No renderer inspection");
    first.unmount();
    const next = renderHook(useGuideReadingFlush, {
      wrapper: GuideReadingFlushProvider,
    });
    const receipt = await double.guideAdmission({
      requestId: "old-admission",
      phase: "admit",
      approvedDraftRevision: inspected.draftRevision,
      approvedRendererId: inspected.rendererId,
    });
    expect(receipt?.saved).toBe(false);
    expect(receipt?.rendererId).not.toBe(inspected.rendererId);
    next.unmount();
  });

  it("reads retained draft edits before the reporting render commits and preserves no-op identity", async () => {
    const double = installDesktopDouble({});
    desktop = double;
    const { result, unmount } = renderHook(useGuideReadingFlush, {
      wrapper: GuideReadingFlushProvider,
    });
    let text = "same body";
    result.current.registerGuard(() => ({
      state: "dirty_draft",
      draftIdentity: text,
    }));
    const inspect = () =>
      double.guideAdmission({ requestId: "inspect", phase: "inspect" });
    const first = await inspect();
    act(() => {
      text = "same body";
    });
    expect((await inspect())?.draftRevision).toBe(first?.draftRevision);
    act(() => {
      text = "new body";
    });
    expect((await inspect())?.draftRevision).not.toBe(first?.draftRevision);
    unmount();
  });

  it.each([false, true])(
    "holds close for a command before any busy-state render and releases it after rejection=%s",
    async (reject) => {
      const double = installDesktopDouble({});
      desktop = double;
      const { result, unmount } = renderHook(
        () => ({
          command: useGuideReadingCommands(async (operation) => operation()),
          owner: useGuideReadingFlush(),
        }),
        { wrapper: GuideReadingFlushProvider },
      );
      let finish: (() => void) | undefined;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const command = result.current
        .command(async () => {
          await waiting;
          if (reject) throw new Error("Refused command");
        })
        .catch(() => undefined);
      const pending = await double.guideAdmission({
        requestId: "during-command",
        phase: "inspect",
      });
      expect(pending?.state).toBe("write_pending");
      finish?.();
      await command;
      expect(
        (
          await double.guideAdmission({
            requestId: "after-command",
            phase: "inspect",
          })
        )?.state,
      ).toBe("clear");
      unmount();
    },
  );

  it("collects other owners when one flush rejects", async () => {
    desktop = installDesktopDouble({});
    const { result, unmount } = renderHook(useGuideReadingFlush, {
      wrapper: GuideReadingFlushProvider,
    });
    result.current.register(async () => {
      throw new Error("save rejected");
    });
    let finish: ((saved: boolean) => void) | undefined;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    result.current.register(() => pending);
    let settled = false;
    const completion = desktop.flushGuideReading().then((saved) => {
      settled = true;
      return saved;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish?.(true);
    expect(await completion).toBe(false);
    unmount();
  });
});
