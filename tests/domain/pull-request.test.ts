import { describe, expect, it } from "vitest";

import { parseGitHubHost } from "../../src/domain/ids";
import { parsePullRequestInput } from "../../src/domain/pull-request";

const expected = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 42,
};

describe("parsePullRequestInput", () => {
  it.each([
    "https://github.com/acme/widgets/pull/42",
    "https://github.com/acme/widgets/pull/42/",
    "https://github.com/acme/widgets/pull/42/files",
    "https://github.com/acme/widgets/pull/42?diff=split",
    "https://github.com/acme/widgets/pull/42#discussion_r1",
    "https://github.com/acme/widgets/pull/42/files?diff=split#discussion_r1",
    "acme/widgets#42",
  ])("parses %s", (input) => {
    expect(parsePullRequestInput(input)).toEqual({
      _tag: "ok",
      value: expected,
    });
  });

  it("uses the supplied GitHub host for a compact reference", () => {
    const host = parseGitHubHost("github.example.com");
    if (host._tag === "err") throw new Error("Expected a GitHub host fixture");

    expect(parsePullRequestInput("acme/widgets#42", host.value)).toEqual({
      _tag: "ok",
      value: { ...expected, host: "github.example.com" },
    });
  });

  it.each([
    "",
    "acme/widgets",
    "https://github.com/acme/widgets/issues/42",
    "https://github.com/acme/widgets/commit/42",
    "https://github.com/acme/widgets/pull/42suffix",
    "http://github.com/acme/widgets/pull/42",
  ])("rejects non-pull-request input %s", (input) => {
    expect(parsePullRequestInput(input)).toEqual({
      _tag: "err",
      error: { _tag: "InvalidPullRequestInput" },
    });
  });
});
