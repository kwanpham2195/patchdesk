import { expect, it } from "vitest";

import { PublicationPreviewService } from "../../src/services/publication-preview-service";

const session = {
  id: "github.com__centraldigital__patchdesk__pr-1__sha-abcdef12__0123456789ab",
  key: { profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 1, headSha: "abcdef1234567890abcdef1234567890abcdef12" },
  state: { _tag: "ReviewCompleted" },
  batchContent: {
    sessionId: "github.com__centraldigital__patchdesk__pr-1__sha-abcdef12__0123456789ab",
    state: { _tag: "Local" }, summaryBody: "Summary", suggestedEvent: "COMMENT", receipts: [], createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    items: [{ _tag: "InlineComment", id: "comment", provenance: { _tag: "human" }, source: "manual", anchor: { path: "src/a.ts", startLine: 2, line: 3, side: "new" }, body: "Check this.", include: true, postability: "postable" }],
  },
};

it("builds the exact local draft publication preview from main-process state", async () => {
  const service = new PublicationPreviewService(
    { async load() { return { _tag: "ok" as const, value: { githubHost: "github.com", ghAccount: "account" } as never }; } },
    { async load() { return { _tag: "ok" as const, value: session as never }; } },
    { async getPullRequest() { return { _tag: "ok" as const, value: { headSha: session.key.headSha } as never }; } },
    { async requireFresh(_profileId: unknown, _reviewId: unknown, expected: { readonly sessionId: unknown }) { return { _tag: "ok" as const, value: { profile: { githubHost: "github.com", ghAccount: "account" } as never, review: {} as never, session: { ...session, id: expected.sessionId } as never, snapshot: {} as never } }; } } as never,
  );
  const result = await service.preview({ profileId: "cfw" as never, reviewId: "github.com__centraldigital__patchdesk__pr-1__review-aaaaaaaaaaaa" as never, sessionId: session.id as never, expectedHeadSha: session.key.headSha, expectedPatchHash: "a".repeat(64), expectedRevision: session.batchContent.updatedAt as never, event: "COMMENT" });
  expect(result).toMatchObject({ _tag: "ok", value: { body: "Summary", headSha: session.key.headSha, inlineComments: [{ itemId: "comment", path: "src/a.ts", startLine: 2, line: 3, side: "new", body: "Check this." }] } });
});
