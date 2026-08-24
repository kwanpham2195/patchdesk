import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCallFlowChildProcess } from "../../src/main/call-flow-runner";

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

  it("rejects a Review that exceeds the source-file limit", async () => {
    const repository = await createLargeSourceRepository();
    const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "src", "changed.ts"),
      "export function changed() { return true; }\n",
    );
    git(repository, ["add", "src/changed.ts"]);
    git(repository, ["commit", "-m", "change large source repository"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]).trim();
    expect(
      analyzeCallFlow(
        {
          sessionId: "session-large-source-repository",
          worktreePath: repository,
          baseSha,
          headSha,
        },
        () => {
          throw new Error("source-file limit must run before CallDiff");
        },
      ),
    ).toEqual({ state: "unavailable", reason: "too_large" });
  });

  it("routes Go through the direct CallDiff wrapper", async () => {
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

    const grammarCache = await mkdtemp(
      join(tmpdir(), "patchdesk-calldiff-grammar-cache-"),
    );
    temporaryRepositories.push(grammarCache);
    const previousGrammarCache = process.env.CALLDIFF_GRAMMAR_CACHE;
    const previousPath = process.env.PATH;
    process.env.CALLDIFF_GRAMMAR_CACHE = grammarCache;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const invocation = {
        sessionId: "session-go-call-flow",
        worktreePath: repository,
        baseSha,
        headSha,
      };
      const output: Array<string> = [];
      await runCallFlowChildProcess(
        Readable.from([JSON.stringify(invocation)]),
        new Writable({
          write(chunk, _encoding, callback) {
            output.push(Buffer.from(chunk).toString("utf8"));
            callback();
          },
        }),
      );
      expect(output.join("")).toContain('"ok":true');
      expect(output.join("")).toContain('"state":"ready"');
      expect(output.join("")).toContain('"analyzed":["Go"]');
      expect(output.join("")).toContain('"file":"payment.go"');
      expect(output.join("")).toContain("CapturePayment");
    } finally {
      if (previousGrammarCache === undefined)
        delete process.env.CALLDIFF_GRAMMAR_CACHE;
      else process.env.CALLDIFF_GRAMMAR_CACHE = previousGrammarCache;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(
      existsSync(join(grammarCache, "node_modules", "tree-sitter-go")),
    ).toBe(false);
  });
  it("routes TypeScript through the direct CallDiff wrapper", async () => {
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
    );

    expect(result.state).toBe("ready");
    expect(fallbackCalls).toEqual([["src/payment.ts"]]);
  });

  it("routes mixed Go and TypeScript paths through one CallDiff run", async () => {
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
    const calls: Array<ReadonlyArray<string>> = [];
    const invocation = {
      sessionId: "session-mixed-routing",
      worktreePath: repository,
      baseSha,
      headSha,
    };
    const engine = (options: {
      readonly paths: ReadonlyArray<string>;
    }): DiffResult => {
      calls.push(options.paths);
      return fakeDiff(baseSha, headSha, "Run", "flow.go");
    };

    const first = analyzeCallFlow(invocation, engine);
    const second = analyzeCallFlow(invocation, engine);

    expect(second).toEqual(first);
    expect(calls).toEqual([
      ["fallback.ts", "flow.go", "helper.go"],
      ["fallback.ts", "flow.go", "helper.go"],
    ]);
    if (first.state !== "ready") return;
    expect(first.trees.map((tree) => tree.entry)).toEqual(["Run"]);
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
  it("accepts CallDiff node kinds and rejects obsolete kinds", () => {
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
            children: [
              {
                key: "branch",
                label: "if ready",
                status: "same",
                kind: "branch",
                children: [],
              },
            ],
          },
        },
      ],
      ascii: "Run",
      changedSteps: 0,
      contextSteps: 2,
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
            tree: { ...outcome.trees[0]?.tree, kind: "dependency" },
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

async function createLargeSourceRepository(): Promise<string> {
  const repository = await mkdtemp(
    join(tmpdir(), "patchdesk-call-flow-large-"),
  );
  temporaryRepositories.push(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "call-flow@example.test"]);
  git(repository, ["config", "user.name", "Call Flow Test"]);
  await mkdir(join(repository, "src"));
  await Promise.all(
    Array.from({ length: 2_500 }, (_, index) =>
      writeFile(join(repository, "src", `source-${index}.ts`), "export {};\n"),
    ),
  );
  git(repository, ["add", "src"]);
  git(repository, ["commit", "-m", "large source repository"]);
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
