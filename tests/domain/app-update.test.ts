import { describe, expect, it } from "vitest";

import { newerReleaseVersion } from "../../src/domain/app-update";

describe("newerReleaseVersion", () => {
  it.each([
    {
      name: "a newer patch",
      tag: "v0.0.18",
      running: "0.0.17",
      want: "0.0.18",
    },
    { name: "a newer minor", tag: "v0.1.0", running: "0.0.17", want: "0.1.0" },
    { name: "a tag without v", tag: "1.0.0", running: "0.9.9", want: "1.0.0" },
    {
      name: "numeric, not text",
      tag: "v0.0.10",
      running: "0.0.9",
      want: "0.0.10",
    },
    {
      name: "the same version",
      tag: "v0.0.17",
      running: "0.0.17",
      want: undefined,
    },
    {
      name: "an older version",
      tag: "v0.0.16",
      running: "0.0.17",
      want: undefined,
    },
    {
      name: "a prerelease",
      tag: "v0.0.18-beta.1",
      running: "0.0.17",
      want: undefined,
    },
    {
      name: "a malformed tag",
      tag: "latest",
      running: "0.0.17",
      want: undefined,
    },
  ])("answers $name", ({ tag, running, want }) => {
    expect(newerReleaseVersion(tag, running)).toBe(want);
  });
});
