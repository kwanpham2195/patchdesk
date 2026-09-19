// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { parsePullRequestInput } from "../../src/domain/pull-request";
import { resolvePullRequestExternalUrl } from "../../src/renderer/src/external-links";

const pullRequest = (() => {
  const parsed = parsePullRequestInput(
    "https://github.com/octo-org/patchdesk/pull/118",
  );
  if (parsed._tag === "err") throw new Error("Fixture pull request is invalid");
  return parsed.value;
})();

describe("review external links", () => {
  it("resolves relative PR links against the immutable configured GitHub host", () => {
    expect(resolvePullRequestExternalUrl("#discussion_r1", pullRequest)).toBe(
      "https://github.com/octo-org/patchdesk/pull/118#discussion_r1",
    );
    expect(
      resolvePullRequestExternalUrl(
        "/octo-org/patchdesk/actions/runs/1",
        pullRequest,
      ),
    ).toBe("https://github.com/octo-org/patchdesk/actions/runs/1");
  });

  it("follows a link off the pull request's host, the way GitHub renders it", () => {
    for (const url of [
      "https://docs.github.com/copilot/how-tos/request-a-code-review",
      "https://circleci.com/pipelines/github/octo-org/patchdesk/1",
      "https://github.com.evil.example/octo-org/patchdesk",
    ]) {
      expect(resolvePullRequestExternalUrl(url, pullRequest)).toBe(url);
    }
  });

  it("makes unsafe schemes, credentialed URLs, and ports inert", () => {
    for (const url of [
      "http://github.com/octo-org/patchdesk",
      "mailto:reviewer@example.com",
      "javascript:alert(1)",
      "https://user:password@github.com/octo-org/patchdesk",
      "https://github.com:8443/octo-org/patchdesk",
      "not a valid url://",
    ]) {
      expect(resolvePullRequestExternalUrl(url, pullRequest)).toBeUndefined();
    }
  });
});
