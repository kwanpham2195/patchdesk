export const submissionFixtureData = {
  batch: {
    sessionId:
      "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdefabcdef",
    state: { _tag: "Local" as const },
    summaryBody: "Request changes before merge.",
    suggestedEvent: "COMMENT" as const,
    items: [
      {
        _tag: "InlineComment" as const,
        id: "p1",
        provenance: { _tag: "human" as const },
        source: "manual" as const,
        include: true,
        anchor: {
          path: "src/services/review-submission-service.ts",
          startLine: 34,
          line: 34,
          side: "new" as const,
        },
        body: "Keep the stale-head check at the write boundary.",
        postability: "postable",
      },
    ],
    receipts: [],
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
  },
};
