// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import {
  cleanup,
  render,
  renderHook,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import { GuideFixtureWorkbench } from "#src/renderer/src/components/guide-fixture-workbench";
import { must } from "#tests/services/insight-run-fixture";
import { saveReviewViewPreferences } from "#src/renderer/src/review-view-preferences";
import { PullRequestImageCacheProvider } from "#src/renderer/src/hooks/use-pull-request-image";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { dragDiffGutter, hoveredGutterButton } from "./pierre-gutter";
import { useDirectConversationActions } from "#src/renderer/src/flows/use-direct-conversation-actions";
import {
  canonicalWorkbenchModel,
  workbenchFixtureData,
} from "#src/renderer/src/flows/fixtures/workbench-fixture-data";

const patchText =
  "diff --git a/src/recovery.ts b/src/recovery.ts\n--- a/src/recovery.ts\n+++ b/src/recovery.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+restorePending()\n context\n";
const guide = must(
  retainGuide(
    {
      groups: [
        {
          title: "Recovery",
          explanation: "Restore state.",
          files: [{ fileId: "f1", relevance: "Recovery owner." }],
        },
        {
          title: "Support",
          explanation: "Shared owner.",
          files: [{ fileId: "f1", relevance: "Supports recovery." }],
        },
      ],
    },
    { patchText, inventory: must(buildGuideInventory(patchText)) },
  ),
);
let desktop: DesktopDouble;
const stubbedReplaceSync = CSSStyleSheet.prototype.replaceSync === undefined;
beforeEach(() => {
  desktop = installDesktopDouble({
    "/v1/reviews/diff-file": () => failure({ error: "not_found" }, 404),
  });
  saveReviewViewPreferences({ diffStyle: "split" });
  if (stubbedReplaceSync) CSSStyleSheet.prototype.replaceSync = () => undefined;
});
afterEach(() => {
  cleanup();
  desktop.restore();
  window.localStorage.clear();
  if (stubbedReplaceSync)
    Reflect.deleteProperty(CSSStyleSheet.prototype, "replaceSync");
});

function reviewBridgeCalls() {
  return desktop.request.mock.calls.filter(
    ([input]) => !("path" in input) || input.path !== "/v1/logs",
  );
}

describe("Guide shared authoring", () => {
  it("publishes an absolute old-side range in a later hunk and shares confirmed edits and replies despite failed observation", async () => {
    const user = userEvent.setup();
    const fullPatch =
      "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/recovery.ts b/src/recovery.ts\n--- a/src/recovery.ts\n+++ b/src/recovery.ts\n@@ -3 +5 @@\n-oldFirst()\n+newFirst()\n@@ -40,4 +60,4 @@\n before\n-oldRetry()\n-oldRecover()\n+newRetry()\n+newRecover()\n after\n";
    const successfulGuide = must(
      retainGuide(
        {
          groups: [
            {
              title: "Recovery",
              explanation: "Restore state.",
              files: [{ fileId: "f2", relevance: "Recovery owner." }],
            },
            {
              title: "Support",
              explanation: "Shared owner.",
              files: [{ fileId: "f2", relevance: "Supports recovery." }],
            },
          ],
        },
        {
          patchText: fullPatch,
          inventory: must(buildGuideInventory(fullPatch)),
        },
      ),
    );
    const base = canonicalWorkbenchModel({
      ...workbenchFixtureData,
      fullPatch,
    });
    const workbench = {
      ...base,
      revision: { ...base.revision, patchHash: "c".repeat(64) },
    };
    desktop.restore();
    let command = 0;
    desktop = installDesktopDouble({
      "/v1/reviews/diff-file": () => failure({ error: "not_found" }, 404),
      "/v1/reviews/inline-conversations/command": () =>
        success(
          command++ === 0
            ? {
                _tag: "CommentCreated",
                commentId: "123",
                commentNodeId: "PRRC_created",
                threadId: "thread-created",
              }
            : { _tag: "ReplyCreated", commentId: "reply-created" },
        ),
      "/v1/reviews/published-comments/edit": () =>
        success({
          _tag: "PublishedCommentEdited",
          commentId: "123",
          reconciliation: "complete",
        }),
    });
    const actions = renderHook(() =>
      useDirectConversationActions({
        workbench,
        runDirectCommand: async (operation) => await operation(),
        appendRecentWrites: () => undefined,
        observeConfirmedReviewWrite: async () => {
          throw new Error("Advisory observation failed");
        },
        requireRecovery: () => {
          throw new Error("Unexpected recovery");
        },
      }),
    );
    render(
      <GuideFixtureWorkbench
        guide={successfulGuide}
        outdated={false}
        localCommentAuthoring={{
          enabled: true,
          onSave: actions.result.current.saveInlineComment,
        }}
        conversationActions={actions.result.current}
      />,
    );
    const first = within(screen.getByRole("list", { name: "Recovery files" }));
    await user.click(
      first.getByRole("button", { name: "File src/recovery.ts" }),
    );
    await dragDiffGutter(
      { line: 41, side: "deletions" },
      { line: 42, side: "deletions" },
    );
    await user.type(
      await screen.findByRole("textbox", { name: "Inline comment" }),
      "Check old recovery range.",
    );
    await user.click(screen.getByRole("button", { name: "Comment now" }));
    const firstThread = await first.findByRole("article", {
      name: "open conversation thread",
    });
    const sent = desktop.request.mock.calls.find(
      ([input]) =>
        "path" in input &&
        input.path === "/v1/reviews/inline-conversations/command",
    );
    expect(sent?.[0]).toMatchObject({
      method: "POST",
      body: {
        command: {
          _tag: "CreateComment",
          anchor: {
            path: "src/recovery.ts",
            startLine: 41,
            line: 42,
            side: "old",
          },
          body: "Check old recovery range.",
          expected: {
            sessionId: "fixture-session",
            headSha: workbench.revision.reviewedHeadSha,
            patchHash: "c".repeat(64),
          },
        },
      },
    });
    const second = within(screen.getByRole("list", { name: "Support files" }));
    await user.click(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    );
    expect(await second.findByText("Check old recovery range.")).toBeDefined();
    await user.click(within(firstThread).getByRole("button", { name: "Edit" }));
    const editor = within(firstThread).getByRole("textbox", {
      name: "Edit comment",
    });
    await user.clear(editor);
    await user.type(editor, "Confirmed edited range.");
    await user.click(within(firstThread).getByRole("button", { name: "Save" }));
    expect(await second.findByText("Confirmed edited range.")).toBeDefined();
    await user.type(
      within(firstThread).getByRole("textbox", { name: "Reply" }),
      "Confirmed range reply.",
    );
    await user.click(
      within(firstThread).getByRole("button", { name: "Reply" }),
    );
    expect(await second.findByText("Confirmed range reply.")).toBeDefined();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    expect(await screen.findByText("Confirmed edited range.")).toBeDefined();
    expect(await screen.findByText("Confirmed range reply.")).toBeDefined();
    const writes = desktop.request.mock.calls.filter(
      ([input]) =>
        "path" in input &&
        [
          "/v1/reviews/inline-conversations/command",
          "/v1/reviews/published-comments/edit",
        ].includes(input.path),
    );
    expect(writes).toHaveLength(3);
    expect(writes[1]?.[0]).toMatchObject({
      body: { commentId: "123", body: "Confirmed edited range." },
    });
    expect(writes[2]?.[0]).toMatchObject({
      body: {
        command: {
          _tag: "Reply",
          threadId: "thread-created",
          body: "Confirmed range reply.",
        },
      },
    });
  });

  it("writes a local note once and shows it in repeated Guide appearances and Diff", async () => {
    const user = userEvent.setup();
    render(<GuideFixtureWorkbench guide={guide} outdated={false} />);
    const first = within(screen.getByRole("list", { name: "Recovery files" }));
    await user.click(
      first.getByRole("button", { name: "File src/recovery.ts" }),
    );
    await dragDiffGutter({ line: 2 });
    await user.type(
      await screen.findByRole("textbox", { name: "Note" }),
      "Check interrupted recovery.",
    );
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Note composer" }),
      ).toBeNull(),
    );
    expect(
      await screen.findByRole("article", { name: /Note on/ }),
    ).toBeDefined();
    const second = within(screen.getByRole("list", { name: "Support files" }));
    await user.click(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    );
    expect(
      await second.findByRole("article", { name: /Note on/ }),
    ).toBeDefined();
    await user.click(
      first.getByRole("checkbox", { name: "Viewed src/recovery.ts" }),
    );
    expect(
      second.getByRole("checkbox", {
        name: "Viewed src/recovery.ts",
        checked: true,
      }),
    ).toBeDefined();
    expect(reviewBridgeCalls()).toEqual([]);
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    const viewed = await screen.findByRole("checkbox", {
      name: "Show file src/recovery.ts",
    });
    expect(viewed.getAttribute("aria-checked")).toBe("true");
    await user.click(viewed);
    expect(
      await screen.findByRole("article", { name: /Note on/ }),
    ).toBeDefined();
    expect(
      screen.getByRole("article", { name: /Note on/ }).textContent,
    ).toContain("Check interrupted recovery.");
    expect(reviewBridgeCalls()).toEqual([
      [
        {
          method: "POST",
          path: "/v1/reviews/diff-file",
          body: {
            profileId: "fixture",
            sessionId:
              "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
            view: "combined",
            path: "src/recovery.ts",
          },
        },
      ],
    ]);
  });
  it("keeps a refused pending draft across repeated appearances and the Diff tab", async () => {
    const user = userEvent.setup();
    render(<GuideFixtureWorkbench guide={guide} outdated={false} />);
    await user.click(
      screen.getByRole("button", { name: "Use pending review fixture" }),
    );
    const first = within(screen.getByRole("list", { name: "Recovery files" }));
    await user.click(
      first.getByRole("button", { name: "File src/recovery.ts" }),
    );
    await dragDiffGutter({ line: 2 });
    await user.type(
      await screen.findByRole("textbox", { name: "Inline comment" }),
      "Check retry ordering.",
    );
    await user.click(screen.getByRole("button", { name: "Start a review" }));
    expect(
      await screen.findByRole("article", {
        name: "Pending review write failed",
      }),
    ).toBeDefined();
    const second = within(screen.getByRole("list", { name: "Support files" }));
    await user.click(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    );
    expect(
      await second.findByRole("article", {
        name: "Pending review write failed",
      }),
    ).toBeDefined();
    expect(reviewBridgeCalls()).toEqual([]);
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    const draft = await screen.findByRole("article", {
      name: "Pending review write failed",
    });
    await user.click(within(draft).getByRole("button", { name: "Edit draft" }));
    expect(
      await screen.findByRole("textbox", { name: "Inline comment" }),
    ).toHaveProperty("value", "Check retry ordering.");
    await user.type(
      screen.getByRole("textbox", { name: "Inline comment" }),
      " Keep this edit.",
    );
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(
      within(screen.getByRole("list", { name: "Recovery files" })).getByRole(
        "button",
        { name: "File src/recovery.ts" },
      ),
    );
    await dragDiffGutter({ line: 2 });
    expect(
      await screen.findByRole("textbox", { name: "Inline comment" }),
    ).toHaveProperty("value", "Check retry ordering. Keep this edit.");
    expect(reviewBridgeCalls()).toEqual([
      [
        {
          method: "POST",
          path: "/v1/reviews/diff-file",
          body: {
            profileId: "fixture",
            sessionId:
              "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
            path: "src/recovery.ts",
          },
        },
      ],
    ]);
  });
  it("removes an open composer and refuses Viewed when retained Guide becomes stale on a fresh workbench", async () => {
    const user = userEvent.setup();
    const view = render(
      <GuideFixtureWorkbench guide={guide} outdated={false} />,
    );
    await user.click(
      within(screen.getByRole("list", { name: "Recovery files" })).getByRole(
        "button",
        { name: "File src/recovery.ts" },
      ),
    );
    await dragDiffGutter({ line: 2 });
    expect(await screen.findByRole("textbox", { name: "Note" })).toBeDefined();
    view.rerender(<GuideFixtureWorkbench guide={guide} outdated />);
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(
      screen
        .getAllByRole("checkbox", { name: "Viewed src/recovery.ts" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    await waitFor(() => expect(hoveredGutterButton({ line: 2 })).toBeNull());
    expect(reviewBridgeCalls()).toEqual([]);
  });
});

it("opens comment evidence links and requests images using the Review's PR/profile from Guide", async () => {
  const user = userEvent.setup();
  const opened: string[] = [];
  desktop.restore();
  desktop = installDesktopDouble(
    {
      "/v1/reviews/markdown-image": () =>
        success({ dataUri: "data:image/png;base64,AA==" }),
    },
    {
      openExternalHttps: async (url) => {
        opened.push(url);
        return true;
      },
    },
  );
  render(
    <PullRequestImageCacheProvider>
      <GuideFixtureWorkbench
        guide={guide}
        outdated={false}
        localCommentAuthoring={{ enabled: true, onSave: async () => undefined }}
        conversationThreads={[
          {
            id: "PRRT_evidence",
            state: "open",
            location: { path: "src/recovery.ts", line: 2, diffSide: "new" },
            comments: [
              {
                id: "PRRC_evidence",
                author: "reviewer",
                createdAt: "2026-10-01T00:00:00Z",
                body: "[Build log](https://ci.example/job/17)\n\n![Screenshot](https://user-images.githubusercontent.com/example.png)",
              },
            ],
          },
        ]}
      />
    </PullRequestImageCacheProvider>,
  );
  await user.click(
    within(screen.getByRole("list", { name: "Recovery files" })).getByRole(
      "button",
      { name: "File src/recovery.ts" },
    ),
  );
  const evidence = within(
    screen.getByRole("group", { name: "Guide evidence src/recovery.ts" }),
  );
  await user.click(await evidence.findByRole("button", { name: /Build log/ }));
  expect(opened).toEqual(["https://ci.example/job/17"]);
  expect(
    await evidence.findByRole("img", { name: "Screenshot" }),
  ).toHaveProperty("src", "data:image/png;base64,AA==");
  expect(
    desktop.request.mock.calls.find(
      ([input]) =>
        "path" in input && input.path === "/v1/reviews/markdown-image",
    )?.[0],
  ).toMatchObject({
    method: "POST",
    body: {
      profileId: "fixture",
      host: "github.com",
      owner: "octo-org",
      repo: "patchdesk",
      number: 42,
      url: "https://user-images.githubusercontent.com/example.png",
    },
  });
});
