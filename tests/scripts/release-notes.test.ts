import { describe, expect, it } from "vitest";

import { extractReleaseNotes } from "../../scripts/release-notes.mjs";

const changelog = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- Added a filter nobody has released yet.",
  "",
  "## 0.1.3 - 2026-09-01",
  "",
  "- Fixed release installs when the machine's pnpm peer setting differs.",
  "- Fixed a second thing.",
  "",
  "## 0.1.2 - 2026-09-01",
  "",
  "- Reduced the macOS download size.",
  "",
  "## 0.1.1 - 2026-09-01",
  "",
].join("\n");

describe("extractReleaseNotes", () => {
  it("reads the body under one version's heading, stopping at the next", () => {
    expect(extractReleaseNotes(changelog, "0.1.3")).toBe(
      [
        "- Fixed release installs when the machine's pnpm peer setting differs.",
        "- Fixed a second thing.",
      ].join("\n"),
    );
  });

  it("reads the last section, which no heading follows", () => {
    expect(extractReleaseNotes(changelog, "0.1.2")).toBe(
      "- Reduced the macOS download size.",
    );
  });

  it("returns undefined for a version the changelog never names", () => {
    expect(extractReleaseNotes(changelog, "9.9.9")).toBeUndefined();
  });

  it("does not match a version that only prefixes a released one", () => {
    expect(extractReleaseNotes(changelog, "0.1")).toBeUndefined();
  });

  it("returns an empty body for a heading with nothing under it", () => {
    expect(extractReleaseNotes(changelog, "0.1.1")).toBe("");
  });

  it("reads a heading written without a date", () => {
    expect(extractReleaseNotes("## 0.2.0\n\n- Shipped it.\n", "0.2.0")).toBe(
      "- Shipped it.",
    );
  });
});
