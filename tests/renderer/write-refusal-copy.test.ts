// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  contextualMessage,
  PatchdeskApiError,
  requestJson,
} from "../../src/renderer/src/api-client";
import { composerErrorMessage } from "../../src/renderer/src/components/review-diff-authoring-errors";
import {
  COMMENT_DELETE_MESSAGES,
  COMMENT_EDIT_MESSAGES,
  REVIEW_DISMISS_MESSAGES,
  THREAD_REPLY_MESSAGES,
} from "../../src/renderer/src/review-copy";
import { refusalCausePhrase } from "../../src/renderer/src/write-refusal-copy";
import { installDesktopDouble } from "./fake-desktop-response";

let desktop: ReturnType<typeof installDesktopDouble> | undefined;

afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

const RAW = "Validation Failed: body is too long (maximum is 65536 characters)";

/** The failure the renderer builds from the route's refusal answer. */
async function refusalFailure(cause: string): Promise<PatchdeskApiError> {
  desktop = installDesktopDouble({
    "/v1/reviews/inline-conversations/command": () => ({
      ok: false,
      status: 409,
      body: { error: "github_refused", cause, message: RAW },
      correlationId: "corr-refused",
    }),
  });
  try {
    await requestJson("/v1/reviews/inline-conversations/command");
  } catch (thrown: unknown) {
    if (thrown instanceof PatchdeskApiError) return thrown;
  }
  throw new Error("expected a PatchdeskApiError");
}

describe("a refused conversation write", () => {
  it("is its own failure kind, so no surface treats it as an unconfirmed write", async () => {
    const failure = await refusalFailure("unprocessable");

    expect(failure.kind).toBe("github_refused");
  });

  it("words a refused inline comment with the cause phrase and the action", async () => {
    const message = composerErrorMessage(await refusalFailure("unprocessable"));

    expect(message).toBe(refusalCausePhrase("unprocessable", "comment"));
    expect(message).not.toContain("Check GitHub");
    expect(message).not.toContain(RAW);
  });

  it("words a refused reply with the cause phrase and the action", async () => {
    const message = contextualMessage(
      await refusalFailure("not_found"),
      THREAD_REPLY_MESSAGES,
    );

    expect(message).toBe(refusalCausePhrase("not_found", "reply"));
    expect(message).not.toContain("Check GitHub");
    expect(message).not.toContain(RAW);
  });

  it.each([
    ["published comment edit", COMMENT_EDIT_MESSAGES, "edit"],
    ["published comment deletion", COMMENT_DELETE_MESSAGES, "deletion"],
    ["review dismissal", REVIEW_DISMISS_MESSAGES, "dismissal"],
  ] as const)(
    "words a refused %s with the cause phrase and the action",
    async (_name, messages, action) => {
      const message = contextualMessage(
        await refusalFailure("not_found"),
        messages,
      );

      expect(message).toBe(refusalCausePhrase("not_found", action));
      expect(message).not.toContain("Check GitHub");
      expect(message).not.toContain(RAW);
    },
  );
});
