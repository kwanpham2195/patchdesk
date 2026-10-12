import { describe, expect, it } from "vitest";
import { checkPackages } from "#scripts/check-package.mjs";

describe("package checks", () => {
  it("checks root ownership without running the runtime suite", async () => {
    const commands: string[] = [];
    const status = await checkPackages(
      ["root"],
      "/fixture",
      new AbortController().signal,
      async (_command, args) => {
        commands.push(args.join(" "));
        return 0;
      },
    );
    expect(status).toBe(0);
    expect(commands).toEqual([
      "typecheck",
      "typecheck:scripts",
      "check:error-ui",
      "check:imports",
      "test:root",
      "exec oxlint --deny-warnings --ignore-pattern runtime/insight/**",
    ]);
  });

  it("checks both affected packages once when selected explicitly", async () => {
    const commands: string[] = [];
    expect(
      await checkPackages(
        ["root", "insight", "insight"],
        "/fixture",
        new AbortController().signal,
        async (_command, args) => {
          commands.push(args.join(" "));
          return 0;
        },
      ),
    ).toBe(0);
    expect(commands.slice(-3)).toEqual([
      "--dir runtime/insight typecheck",
      "exec oxlint --deny-warnings runtime/insight",
      "test:insight",
    ]);
    expect(commands.filter((value) => value === "test:insight")).toHaveLength(
      1,
    );
  });

  it("rejects the entire selection before executing an unknown package", async () => {
    const commands: string[] = [];
    expect(
      await checkPackages(
        ["root", "missing"],
        "/fixture",
        new AbortController().signal,
        async (_command, args) => {
          commands.push(args.join(" "));
          return 0;
        },
      ),
    ).toBe(2);
    expect(commands).toEqual([]);
  });

  it("refuses an absent selection", async () => {
    expect(
      await checkPackages([], "/fixture", new AbortController().signal),
    ).toBe(2);
  });

  it("stops on runtime compiler failure without lint or tests", async () => {
    const commands: string[] = [];
    expect(
      await checkPackages(
        ["insight"],
        "/fixture",
        new AbortController().signal,
        async (_command, args) => {
          commands.push(args.join(" "));
          return 7;
        },
      ),
    ).toBe(7);
    expect(commands).toEqual(["--dir runtime/insight typecheck"]);
  });
});
