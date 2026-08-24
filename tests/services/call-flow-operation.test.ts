import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeCallFlow,
  parseCallFlowOutcome,
} from "../../src/services/call-flow-operation";
import type { DiffResult } from "calldiff";

const temporaryRepositories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("analyzeCallFlow", () => {
  it("compares exact commits and returns bounded source locations", async () => {
    const repository = await createRepository();
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "src", "payment.ts"),
      [
        "export function capturePayment(value: number) {",
        "  if (value > 0) authorizeCharge(value);",
        "}",
        "function authorizeCharge(value: number) { return value; }",
        "",
      ].join("\n"),
    );
    git(repository, ["add", "src/payment.ts"]);
    git(repository, ["commit", "-m", "change call path"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = analyzeCallFlow({
      sessionId: "session-call-flow",
      worktreePath: repository,
      baseSha,
      headSha,
    });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.snapshot).toEqual({
      sessionId: "session-call-flow",
      baseSha,
      headSha,
    });
    expect(result.changedSteps).toBeGreaterThan(0);
    expect(result.languages.analyzed).toContain("TypeScript");
    expect(result.trees[0]?.tree.file).toBe("src/payment.ts");
    expect(result.ascii).toContain("capturePayment");
  });

  it("reports a Review whose changed files use no packaged language", async () => {
    const repository = await createRepository();
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, "README.md"), "Changed prose\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "change prose"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = analyzeCallFlow({
      sessionId: "session-unsupported",
      worktreePath: repository,
      baseSha,
      headSha,
    });

    expect(result).toMatchObject({
      state: "unsupported",
      languages: { skippedChangedFiles: 1 },
    });
  });

  it("analyzes Go with the packaged grammar", async () => {
    const repository = await createGoRepository();
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "payment.go"),
      [
        "package payment",
        "",
        "func CapturePayment(value int) int {",
        "\tif value > 0 {",
        "\t\treturn authorizeCharge(value)",
        "\t}",
        "\treturn value",
        "}",
        "",
        "func authorizeCharge(value int) int { return value }",
        "",
      ].join("\n"),
    );
    git(repository, ["add", "payment.go"]);
    git(repository, ["commit", "-m", "change Go call path"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = analyzeCallFlow(
      {
        sessionId: "session-go-call-flow",
        worktreePath: repository,
        baseSha,
        headSha,
      },
      () => {
        throw new Error("Go paths must not use the CallDiff fallback");
      },
    );

    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.languages).toEqual({
      analyzed: ["Go"],
      available: 5,
      skippedChangedFiles: 0,
    });
    expect(result.changedSteps).toBeGreaterThan(0);
    expect(result.trees.some((tree) => tree.tree.file === "payment.go")).toBe(
      true,
    );
    expect(result.ascii).toContain("CapturePayment");
  });
  it("routes TypeScript through the unchanged CallDiff fallback only", async () => {
    const repository = await createRepository();
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "src", "payment.ts"),
      "export function capturePayment() { return authorize(); }\nfunction authorize() { return true; }\n",
    );
    git(repository, ["add", "src/payment.ts"]);
    git(repository, ["commit", "-m", "change TypeScript flow"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]).trim();
    const fallbackCalls: Array<ReadonlyArray<string>> = [];

    const result = analyzeCallFlow(
      {
        sessionId: "session-ts-fallback",
        worktreePath: repository,
        baseSha,
        headSha,
      },
      (options) => {
        fallbackCalls.push(options.paths);
        return fakeDiff(baseSha, headSha, "capturePayment", "src/payment.ts");
      },
      () => {
        throw new Error("TypeScript paths must not use the Go rule");
      },
    );

    expect(result.state).toBe("ready");
    expect(fallbackCalls).toEqual([["src/payment.ts"]]);
  });

  it("partitions mixed Go and TypeScript paths deterministically", async () => {
    const repository = await createMixedRepository();
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "fallback.ts"),
      "export function Fallback() { return changed(); }\nfunction changed() {}\n",
    );
    await writeFile(
      join(repository, "flow.go"),
      "package flow\n\nfunc Run() { changed() }\nfunc changed() {}\n",
    );
    git(repository, ["add", "fallback.ts", "flow.go"]);
    git(repository, ["commit", "-m", "change mixed flows"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]).trim();
    const fallbackCalls: Array<ReadonlyArray<string>> = [];
    const goCalls: Array<{
      readonly paths: ReadonlyArray<string>;
      readonly changedPaths: ReadonlyArray<string>;
    }> = [];
    const invocation = {
      sessionId: "session-mixed-routing",
      worktreePath: repository,
      baseSha,
      headSha,
    };
    const fallback = (options: {
      readonly paths: ReadonlyArray<string>;
    }): DiffResult => {
      fallbackCalls.push(options.paths);
      return fakeDiff(baseSha, headSha, "Zed", "fallback.ts");
    };
    const goRule = (options: {
      readonly paths: ReadonlyArray<string>;
      readonly changedPaths: ReadonlyArray<string>;
    }): DiffResult => {
      goCalls.push({
        paths: options.paths,
        changedPaths: options.changedPaths,
      });
      return fakeDiff(baseSha, headSha, "Alpha", "flow.go");
    };

    const first = analyzeCallFlow(invocation, fallback, goRule);
    const second = analyzeCallFlow(invocation, fallback, goRule);

    expect(second).toEqual(first);
    expect(fallbackCalls).toEqual([["fallback.ts"], ["fallback.ts"]]);
    expect(goCalls).toEqual([
      { paths: ["flow.go", "helper.go"], changedPaths: ["flow.go"] },
      { paths: ["flow.go", "helper.go"], changedPaths: ["flow.go"] },
    ]);
    if (first.state !== "ready") return;
    expect(first.trees.map((tree) => tree.entry)).toEqual(["Alpha", "Zed"]);
  });

  it("maps only the Go rule budget failure to too_large", async () => {
    const repository = await createGoRepository();
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    const calls = Array.from(
      { length: 513 },
      (_, index) => `\tb.unknown${index}()`,
    ).join("\n");
    await writeFile(
      join(repository, "payment.go"),
      `package payment\n\ntype Budget struct{}\n\nfunc (b *Budget) CapturePayment() {\n${calls}\n}\n`,
    );
    git(repository, ["add", "payment.go"]);
    git(repository, ["commit", "-m", "exceed Go rule budget"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]).trim();
    const invocation = {
      sessionId: "session-go-too-large",
      worktreePath: repository,
      baseSha,
      headSha,
    };
    const fallback = (): never => {
      throw new Error("Go paths must not use the fallback");
    };

    expect(analyzeCallFlow(invocation, fallback)).toEqual({
      state: "unavailable",
      reason: "too_large",
    });
    expect(() =>
      analyzeCallFlow(invocation, fallback, () => {
        throw new Error("unexpected Go engine defect");
      }),
    ).toThrowError("unexpected Go engine defect");
  });

  it("excludes standard generated Go files and counts changed skips", async () => {
    const repository = await createGeneratedGoRepository();
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "flow.go"),
      "package flow\n\nfunc Run() { changed() }\nfunc changed() {}\n",
    );
    for (const name of ["schema.gen.go", "zz_generated.deepcopy.go"]) {
      await writeFile(
        join(repository, name),
        `package flow\n\n// changed ${name}\n`,
      );
    }
    await writeFile(
      join(repository, "marker.go"),
      "// Code generated by fixture. DO NOT EDIT.\n\npackage flow\n\nconst Changed = true\n",
    );
    git(repository, [
      "add",
      "flow.go",
      "schema.gen.go",
      "zz_generated.deepcopy.go",
      "marker.go",
    ]);
    git(repository, ["commit", "-m", "change generated and owned Go"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]).trim();
    const goCalls: Array<ReadonlyArray<string>> = [];

    const result = analyzeCallFlow(
      {
        sessionId: "session-generated-go",
        worktreePath: repository,
        baseSha,
        headSha,
      },
      () => {
        throw new Error("Go paths must not use the fallback");
      },
      (options) => {
        goCalls.push(options.paths);
        return fakeDiff(baseSha, headSha, "Run", "flow.go");
      },
    );

    expect(goCalls).toEqual([
      ["flow.go", "schema.gen.go", "zz_generated.deepcopy.go"],
    ]);
    expect(result).toMatchObject({
      state: "ready",
      languages: {
        analyzed: ["Go"],
        skippedChangedFiles: 1,
      },
    });
  });
});

describe("parseCallFlowOutcome", () => {
  it("accepts every semantic node kind and rejects unknown kinds", () => {
    const semanticKinds = [
      "call",
      "branch",
      "unresolved",
      "dependency",
      "reference",
      "concurrent",
      "deferred",
    ] as const;
    const outcome = {
      state: "ready",
      snapshot: {
        sessionId: "semantic-kinds",
        baseSha: "1".repeat(40),
        headSha: "2".repeat(40),
      },
      trees: [
        {
          entry: "Run",
          ascii: "Run",
          tree: {
            key: "Run",
            label: "Run()",
            status: "same",
            kind: "call",
            children: semanticKinds.slice(1).map((kind) => ({
              key: kind,
              label: kind,
              status: "same",
              kind,
              children: [],
            })),
          },
        },
      ],
      ascii: "Run",
      changedSteps: 0,
      contextSteps: semanticKinds.length,
      impactedFiles: 0,
      languages: { analyzed: ["Go"], available: 5, skippedChangedFiles: 0 },
      truncated: false,
    };

    expect(parseCallFlowOutcome(outcome)).toBeDefined();
    expect(
      parseCallFlowOutcome({
        ...outcome,
        trees: [
          {
            ...outcome.trees[0],
            tree: { ...outcome.trees[0]?.tree, kind: "unknown" },
          },
        ],
      }),
    ).toBeUndefined();
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "patchdesk-call-flow-"));
  temporaryRepositories.push(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "call-flow@example.test"]);
  git(repository, ["config", "user.name", "Call Flow Test"]);
  await mkdir(join(repository, "src"));
  await writeFile(
    join(repository, "src", "payment.ts"),
    [
      "export function capturePayment(value: number) {",
      "  return formatMoney(value);",
      "}",
      "function formatMoney(value: number) { return value.toFixed(2); }",
      "",
    ].join("\n"),
  );
  await writeFile(join(repository, "README.md"), "Fixture\n");
  git(repository, ["add", "src/payment.ts", "README.md"]);
  git(repository, ["commit", "-m", "base"]);
  return repository;
}

async function createGoRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "patchdesk-call-flow-go-"));
  temporaryRepositories.push(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "call-flow@example.test"]);
  git(repository, ["config", "user.name", "Call Flow Test"]);
  await writeFile(
    join(repository, "payment.go"),
    [
      "package payment",
      "",
      "func CapturePayment(value int) int {",
      "\treturn formatMoney(value)",
      "}",
      "",
      "func formatMoney(value int) int { return value }",
      "",
    ].join("\n"),
  );
  git(repository, ["add", "payment.go"]);
  git(repository, ["commit", "-m", "base"]);
  return repository;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createMixedRepository(): Promise<string> {
  const repository = await mkdtemp(
    join(tmpdir(), "patchdesk-call-flow-mixed-"),
  );
  temporaryRepositories.push(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "call-flow@example.test"]);
  git(repository, ["config", "user.name", "Call Flow Test"]);
  await writeFile(
    join(repository, "fallback.ts"),
    "export function Fallback() { return original(); }\nfunction original() {}\n",
  );
  await writeFile(
    join(repository, "flow.go"),
    "package flow\n\nfunc Run() { original() }\nfunc original() {}\n",
  );
  await writeFile(
    join(repository, "helper.go"),
    "package flow\n\nfunc UnchangedHelper() {}\n",
  );
  git(repository, ["add", "fallback.ts", "flow.go", "helper.go"]);
  git(repository, ["commit", "-m", "base"]);
  return repository;
}

async function createGeneratedGoRepository(): Promise<string> {
  const repository = await mkdtemp(
    join(tmpdir(), "patchdesk-call-flow-generated-"),
  );
  temporaryRepositories.push(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "call-flow@example.test"]);
  git(repository, ["config", "user.name", "Call Flow Test"]);
  await writeFile(
    join(repository, "flow.go"),
    "package flow\n\nfunc Run() { original() }\nfunc original() {}\n",
  );
  await writeFile(join(repository, "schema.gen.go"), "package flow\n");
  await writeFile(
    join(repository, "zz_generated.deepcopy.go"),
    "package flow\n",
  );
  await writeFile(
    join(repository, "marker.go"),
    "// Code generated by fixture. DO NOT EDIT.\n\npackage flow\n",
  );
  git(repository, [
    "add",
    "flow.go",
    "schema.gen.go",
    "zz_generated.deepcopy.go",
    "marker.go",
  ]);
  git(repository, ["commit", "-m", "base"]);
  return repository;
}

function fakeDiff(
  from: string,
  to: string,
  entry: string,
  file: string,
): DiffResult {
  const tree: DiffResult["trees"][number]["tree"] = {
    key: entry,
    label: `${entry}()`,
    status: "added",
    kind: "call",
    file,
    line: 1,
    children: [],
  };
  return {
    mode: "diff",
    from,
    to,
    trees: [{ entry, ascii: `+ ${entry}()  ${file}:1`, tree }],
    ascii: `+ ${entry}()  ${file}:1`,
  };
}
