// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { parsePullRequestInput } from "../../src/domain/pull-request";
import { resolvePullRequestExternalUrl } from "../../src/renderer/src/external-links";

const pullRequest = (() => {
  const parsed = parsePullRequestInput(
    "https://github.com/centraldigital/patchdesk/pull/118",
  );
  if (parsed._tag === "err") throw new Error("Fixture pull request is invalid");
  return parsed.value;
})();

describe("review external links", () => {
  it("resolves relative PR links against the immutable configured GitHub host", () => {
    expect(resolvePullRequestExternalUrl("#discussion_r1", pullRequest)).toBe(
      "https://github.com/centraldigital/patchdesk/pull/118#discussion_r1",
    );
    expect(
      resolvePullRequestExternalUrl(
        "/centraldigital/patchdesk/actions/runs/1",
        pullRequest,
      ),
    ).toBe("https://github.com/centraldigital/patchdesk/actions/runs/1");
  });

  it("makes unsafe schemes, credentialed URLs, ports, and cross-host URLs inert", () => {
    for (const url of [
      "http://github.com/centraldigital/patchdesk",
      "mailto:reviewer@example.com",
      "javascript:alert(1)",
      "https://github.com.evil.example/centraldigital/patchdesk",
      "https://user:password@github.com/centraldigital/patchdesk",
      "https://github.com:8443/centraldigital/patchdesk",
      "not a valid url://",
    ]) {
      expect(resolvePullRequestExternalUrl(url, pullRequest)).toBeUndefined();
    }
  });
});
