import { describe, expect, it } from "vitest";

import { decideReactDoctor } from "../../scripts/precommit.mjs";

describe("decideReactDoctor", () => {
  it("runs the scan when package.json agrees between index and worktree", () => {
    expect(
      decideReactDoctor({
        packageJsonDiffers: false,
        stagedPaths: ["src/renderer/src/screens/review.tsx"],
      }),
    ).toEqual({ action: "run" });
  });

  it("fails when package.json differs and renderer files are staged", () => {
    const decision = decideReactDoctor({
      packageJsonDiffers: true,
      stagedPaths: ["src/services/review.ts", "src/renderer/src/app.tsx"],
    });

    expect(decision.action).toBe("fail");
    expect(decision).toMatchObject({
      message:
        "React Doctor cannot scan: package.json differs between index and worktree, and renderer files are staged. Stage or restore package.json, then retry.\n",
    });
  });

  it("skips, saying nothing was scanned, when no renderer file is staged", () => {
    const decision = decideReactDoctor({
      packageJsonDiffers: true,
      stagedPaths: ["scripts/precommit.mjs", "AGENTS.md"],
    });

    expect(decision.action).toBe("skip");
    expect(decision).toMatchObject({
      message:
        "React Doctor skipped: package.json differs between index and worktree. Nothing was scanned.\n",
    });
  });

  it("skips rather than failing when nothing at all is staged", () => {
    expect(
      decideReactDoctor({ packageJsonDiffers: true, stagedPaths: [] }).action,
    ).toBe("skip");
  });
});
