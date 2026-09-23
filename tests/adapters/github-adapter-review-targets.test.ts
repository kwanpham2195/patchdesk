import { orderedTransport } from "./github-transport-doubles";
import { parseGitHubThreadId, parseGitSha } from "../../src/domain/ids";
import { describe, expect, it } from "vitest";
import {
  created,
  headSha,
  mustParse,
  profile,
  pr,
  testAdapter,
  sent,
  sentArgv,
  golden,
  payload,
} from "./github-adapter-test-support";

describe("GitHubAdapter review target and merge writes", () => {
  it("proves a review thread target with one bounded node query", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRT_thread",
            comments: {
              nodes: [
                {
                  id: "PRRC_c1",
                  pullRequest: {
                    repository: {
                      owner: { login: "octo-org" },
                      name: "patchdesk",
                    },
                    number: 42,
                  },
                },
              ],
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_thread")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: true } });
    const request = sent(transport, 0).argv.join(" ");
    expect(transport.requests).toHaveLength(1);
    expect(request).toContain("query ReviewThreadTarget($id: ID!)");
    expect(request).toContain("comments(first: 1)");
    expect(request).toContain("-F id=PRRT_thread");
    // The proof never carries conversation content.
    expect(request).not.toContain("body");
    expect(request).not.toContain("author");
    expect(request).not.toContain("viewerDidAuthor");
  });

  it("treats a thread from another pull request as not found without disclosing it", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRT_foreign",
            comments: {
              nodes: [
                {
                  id: "PRRC_c1",
                  pullRequest: {
                    repository: {
                      owner: { login: "octo-org" },
                      name: "patchdesk",
                    },
                    number: 99,
                  },
                },
              ],
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_foreign")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("treats a missing thread node as not found", async () => {
    const adapter = testAdapter(
      orderedTransport([JSON.stringify({ data: { node: null } })]),
    );
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_gone")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("treats a thread node with no comments connection as not found", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify({ data: { node: { id: "PRRT_thread" } } }),
      ]),
    );
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_thread")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("treats a thread with no comment nodes as not found", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify({
          data: {
            node: { id: "PRRT_empty", comments: { nodes: [] } },
          },
        }),
      ]),
    );
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_empty")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("proves a review comment target with viewer authorship", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRC_comment",
            viewerDidAuthor: true,
            pullRequest: {
              repository: {
                owner: { login: "octo-org" },
                name: "patchdesk",
              },
              number: 42,
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getReviewCommentTarget({
        profile,
        pr,
        commentId: "PRRC_comment",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { found: true, viewerDidAuthor: true },
    });
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain("query ReviewCommentTarget($id: ID!)");
    expect(request).toContain("viewerDidAuthor");
    expect(request).not.toContain("body");
  });

  it("treats a comment on another pull request as not found", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRC_foreign",
            viewerDidAuthor: true,
            pullRequest: {
              repository: {
                owner: { login: "octo-org" },
                name: "patchdesk",
              },
              number: 99,
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getReviewCommentTarget({
        profile,
        pr,
        commentId: "PRRC_foreign",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("reports a comment on this pull request that the viewer did not author", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRC_other",
            viewerDidAuthor: false,
            pullRequest: {
              repository: {
                owner: { login: "octo-org" },
                name: "patchdesk",
              },
              number: 42,
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getReviewCommentTarget({ profile, pr, commentId: "PRRC_other" }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { found: true, viewerDidAuthor: false },
    });
  });

  it("degrades the create receipt instead of failing when the thread read-back hard-fails, and does not retry", async () => {
    const transport = orderedTransport([
      JSON.stringify({ node_id: "PRRC_comment" }),
      { _tag: "CommandFailed" },
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      }),
    ).resolves.toEqual({ _tag: "ok", value: created });
    // A transport/command error stops the read-back immediately: retrying
    // against a hard failure is a different problem than eventual
    // consistency, and the create must not be held hostage to it.
    expect(transport.requests).toHaveLength(2);
  });

  it("merges only through the explicit SHA-pinned GitHub endpoint", async () => {
    const [mergeArgv, mergePayload] = await Promise.all([
      golden("merge-pull-request"),
      payload("merge-pull-request.json"),
    ]);
    const transport = orderedTransport([
      JSON.stringify({ merged: true, sha: headSha }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.mergePullRequest({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        method: "squash",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { mergeCommitSha: mustParse(parseGitSha(headSha)) },
    });
    expect(sentArgv(transport)).toEqual([mergeArgv]);
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).toEqual(
      JSON.parse(mergePayload),
    );
  });
});
