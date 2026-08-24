import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  runGoCallFlowRule,
  type GoCallFlowRuleOptions,
} from "../../src/services/go-call-flow-rule";
import type { DiffNode, DiffResult } from "calldiff";

const temporaryRepositories: Array<string> = [];

const GO_BUILTIN_FUNCTIONS = [
  "append",
  "cap",
  "clear",
  "close",
  "complex",
  "copy",
  "delete",
  "imag",
  "len",
  "make",
  "max",
  "min",
  "new",
  "panic",
  "print",
  "println",
  "real",
  "recover",
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("runGoCallFlowRule", () => {
  it("applies the complete syntactic Go call-flow rule deterministically", async () => {
    const repository = await createRepository(BASE_SOURCE);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, "flow.go"), HEAD_SOURCE);
    git(repository, ["add", "flow.go"]);
    git(repository, ["commit", "-m", "exercise Go language rule"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();
    const options: GoCallFlowRuleOptions = {
      cwd: repository,
      from,
      to,
      paths: ["flow.go", "types.go"],
      changedPaths: ["flow.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    };

    const first = runGoCallFlowRule(options);
    const second = runGoCallFlowRule(options);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ mode: "diff", from, to });
    expect(
      first.trees.some((tree) => tree.tree.label.startsWith("Gateway.Run")),
    ).toBe(true);
    expect(first.trees.map((tree) => tree.entry)).toContain("Gateway.Run");
    expect(
      first.trees.every(
        (tree) =>
          !tree.entry.startsWith("go:") &&
          !tree.entry.includes("\0") &&
          !tree.entry.includes('["'),
      ),
    ).toBe(true);

    const nodes = flatten(first);
    expect(
      nodes.some(
        (node) => node.kind === "call" && node.label.startsWith("Gateway.send"),
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (node) =>
          node.kind === "dependency" &&
          node.label === "client.Send()" &&
          node.key.includes("g.client.Send") &&
          node.children.length === 0,
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (node) =>
          node.kind === "unresolved" &&
          node.label === "g.unknown()" &&
          node.children.length === 0,
      ),
    ).toBe(true);
    for (const omitted of [
      "client.Send()",
      'http.Get("https://example.test")',
      "pkg.Client.Send()",
      "other.send()",
      "fn()",
    ]) {
      expect(
        nodes.some(
          (node) =>
            node.key === `unresolved:${omitted}` ||
            node.key === `dependency:${omitted}`,
        ),
      ).toBe(false);
    }

    expect(nodes.some((node) => node.key === "int")).toBe(false);
    expect(nodes.some((node) => node.key === "string")).toBe(false);
    expect(nodes.some((node) => node.key === "LocalID")).toBe(false);
    for (const builtin of GO_BUILTIN_FUNCTIONS) {
      expect(nodes.some((node) => node.label === builtin)).toBe(false);
    }

    expect(
      nodes.some(
        (node) =>
          node.kind === "reference" && node.label === "references g.send",
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (node) => node.kind === "call" && node.label.includes("reference:"),
      ),
    ).toBe(false);
    expect(nodes.some((node) => node.label === "g.callback")).toBe(false);

    const goBranch = nodes.find(
      (node) => node.kind === "concurrent" && node.label === "go",
    );
    const deferBranch = nodes.find(
      (node) => node.kind === "deferred" && node.label === "defer func",
    );
    expect(
      goBranch?.children.some((node) => node.label.startsWith("asyncWork")),
    ).toBe(true);
    expect(
      deferBranch?.children.some((node) => node.label.startsWith("cleanup")),
    ).toBe(true);
    const directDeferred = [
      "defer cleanupDirect()",
      "defer client.Close()",
      'defer http.Get("https://example.test")',
      "defer wg.Done()",
    ];
    for (const label of directDeferred) {
      expect(
        nodes.find((node) => node.kind === "deferred" && node.label === label),
      ).toMatchObject({ children: [], file: "flow.go" });
    }

    expect(
      nodes.some(
        (node) => node.label.startsWith("legacy") && node.status === "removed",
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (node) => node.label === "client.Send()" && node.status === "added",
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (node) =>
          node.label.startsWith("Gateway.send") && node.status === "same",
      ),
    ).toBe(true);
    expect(
      nodes
        .filter((node) => node.file !== undefined)
        .every(
          (node) =>
            node.file === "flow.go" && node.line !== undefined && node.line > 0,
        ),
    ).toBe(true);
    expect(first.ascii).toContain("[reference] references g.send");
    expect(first.ascii).toContain("[dependency] client.Send");
    expect(first.ascii).toContain("[unresolved] g.unknown");
    expect(first.ascii).toContain("go");
    expect(first.ascii).toContain("defer");
    const run = first.trees.find((tree) => tree.entry === "Gateway.Run");
    const childLabels = run?.tree.children.map((node) => node.label) ?? [];
    expect(nodes.some((node) => node.kind === "branch")).toBe(false);
    expect(childLabels.indexOf("ready()")).toBeLessThan(
      childLabels.indexOf("ifWork()"),
    );
    expect(childLabels.indexOf("classify")).toBeLessThan(
      childLabels.indexOf("caseWork()"),
    );
    expect(
      run?.tree.children.filter((node) => node.label.startsWith("caseWork")),
    ).toHaveLength(1);
  });
  it("keeps same-named functions and methods scoped to their package", async () => {
    const repository = await createEmptyRepository("packages");
    await mkdir(join(repository, "alpha"));
    await mkdir(join(repository, "beta"));
    await writeFile(
      join(repository, "alpha", "flow.go"),
      packageFixture("alpha", "Alpha", "Base"),
    );
    await writeFile(
      join(repository, "beta", "flow.go"),
      packageFixture("beta", "Beta", "Base"),
    );
    git(repository, ["add", "alpha/flow.go", "beta/flow.go"]);
    git(repository, ["commit", "-m", "base packages"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "alpha", "flow.go"),
      packageFixture("alpha", "Alpha", "Head"),
    );
    await writeFile(
      join(repository, "beta", "flow.go"),
      packageFixture("beta", "Beta", "Head"),
    );
    git(repository, ["add", "alpha/flow.go", "beta/flow.go"]);
    git(repository, ["commit", "-m", "change both packages"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runGoCallFlowRule({
      cwd: repository,
      from,
      to,
      paths: ["alpha/flow.go", "beta/flow.go"],
      changedPaths: ["alpha/flow.go", "beta/flow.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    });

    expect([...result.trees.map((tree) => tree.entry)].sort()).toEqual([
      "alpha.Run",
      "alpha.Service.Refresh",
      "beta.Run",
      "beta.Service.Refresh",
    ]);
    expect(new Set(result.trees.map((tree) => tree.entry)).size).toBe(
      result.trees.length,
    );
    expect(
      result.trees.every(
        (tree) =>
          !tree.entry.startsWith("go:") &&
          !tree.entry.includes("\0") &&
          !tree.entry.includes('["'),
      ),
    ).toBe(true);

    const packages: ReadonlyArray<readonly [string, string, string]> = [
      ["alpha/flow.go", "AlphaHead", "BetaHead"],
      ["beta/flow.go", "BetaHead", "AlphaHead"],
    ];
    for (const [file, own, other] of packages) {
      const roots = result.trees.filter(
        (tree) =>
          tree.tree.file === file &&
          (tree.tree.label.startsWith("Run") ||
            tree.tree.label.startsWith("Service.Refresh")),
      );
      expect(roots).toHaveLength(2);
      for (const root of roots) {
        const labels = flattenNode(root.tree).map((node) => node.label);
        expect(labels.some((label) => label.startsWith(own))).toBe(true);
        expect(labels.some((label) => label.startsWith(other))).toBe(false);
      }
    }
  });

  it("qualifies same-directory package and external-test roots", async () => {
    const repository = await createEmptyRepository("external-test-package");
    await mkdir(join(repository, "same"));
    await writeFile(
      join(repository, "same", "foo.go"),
      packageFixture("foo", "Foo", "Base"),
    );
    await writeFile(
      join(repository, "same", "foo_test.go"),
      packageFixture("foo_test", "FooTest", "Base"),
    );
    git(repository, ["add", "same/foo.go", "same/foo_test.go"]);
    git(repository, ["commit", "-m", "base same-directory packages"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "same", "foo.go"),
      packageFixture("foo", "Foo", "Head"),
    );
    await writeFile(
      join(repository, "same", "foo_test.go"),
      packageFixture("foo_test", "FooTest", "Head"),
    );
    git(repository, ["add", "same/foo.go", "same/foo_test.go"]);
    git(repository, ["commit", "-m", "change same-directory packages"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runGoCallFlowRule({
      cwd: repository,
      from,
      to,
      paths: ["same/foo.go", "same/foo_test.go"],
      changedPaths: ["same/foo.go", "same/foo_test.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    });

    expect([...result.trees.map((tree) => tree.entry)].sort()).toEqual([
      "same/foo.Run",
      "same/foo.Service.Refresh",
      "same/foo_test.Run",
      "same/foo_test.Service.Refresh",
    ]);
  });

  it("extracts named generic and unnamed receiver methods", async () => {
    const repository = await createEmptyRepository("receivers");
    await writeFile(join(repository, "generic.go"), genericFixture("Before"));
    git(repository, ["add", "generic.go"]);
    git(repository, ["commit", "-m", "base receivers"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, "generic.go"), genericFixture("After"));
    git(repository, ["add", "generic.go"]);
    git(repository, ["commit", "-m", "change receivers"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runGoCallFlowRule({
      cwd: repository,
      from,
      to,
      paths: ["generic.go"],
      changedPaths: ["generic.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    });

    expect(result.trees.map((tree) => tree.tree.label)).toEqual(
      expect.arrayContaining(["Box.Generic()", "Box.Unnamed()"]),
    );
    const generic = result.trees.find((tree) =>
      tree.tree.label.startsWith("Box.Generic"),
    );
    const unnamed = result.trees.find((tree) =>
      tree.tree.label.startsWith("Box.Unnamed"),
    );
    expect(generic).toBeDefined();
    expect(unnamed).toBeDefined();
    const genericNodes = generic === undefined ? [] : flattenNode(generic.tree);
    const unnamedNodes = unnamed === undefined ? [] : flattenNode(unnamed.tree);
    expect(
      genericNodes.some(
        (node) => node.kind === "call" && node.label.startsWith("Box.Touch"),
      ),
    ).toBe(true);
    expect(
      genericNodes.some(
        (node) =>
          node.kind === "reference" && node.label === "references b.Touch",
      ),
    ).toBe(true);
    expect(unnamedNodes.some((node) => node.label === "other.Touch")).toBe(
      false,
    );
    expect(unnamedNodes.some((node) => node.kind === "reference")).toBe(false);
  });

  it("classifies receiver-held collaborator calls as dependency boundaries", async () => {
    const repository = await createEmptyRepository("signal-filter");
    await writeFile(join(repository, "signal.go"), signalFixture("base"));
    git(repository, ["add", "signal.go"]);
    git(repository, ["commit", "-m", "base signal filter"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, "signal.go"), signalFixture("head"));
    git(repository, ["add", "signal.go"]);
    git(repository, ["commit", "-m", "change receiver collaborator"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runGoCallFlowRule({
      cwd: repository,
      from,
      to,
      paths: ["signal.go"],
      changedPaths: ["signal.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    });
    const nodes = flatten(result);
    expect(
      nodes.some(
        (node) => node.kind === "dependency" && node.label === "svc.Refresh()",
      ),
    ).toBe(true);
    for (const omitted of [
      "log.Errorf",
      "fmt.Sprintf",
      "observability.Record",
      "tracing.Start",
      "wg.Add",
      "wg.Done",
      "wg.Wait",
      "refreshErrors.Add",
      "refreshErrors.Load",
      "fn",
      "group.POST",
    ]) {
      expect(nodes.some((node) => node.label === omitted)).toBe(false);
    }
    expect(
      nodes.some(
        (node) => node.kind === "call" && node.label === "resolvedAfter()",
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (node) => node.kind === "call" && node.label === "Handler.Handle()",
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (node) =>
          node.kind === "reference" && node.label === "references h.Handle",
      ),
    ).toBe(true);
  });

  it("uses bounded normalized call-site arguments for calls and defers", async () => {
    const repository = await createEmptyRepository("call-site-arguments");
    await writeFile(
      join(repository, "arguments.go"),
      argumentFixture("beforeCtx"),
    );
    git(repository, ["add", "arguments.go"]);
    git(repository, ["commit", "-m", "base call-site arguments"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repository, "arguments.go"),
      argumentFixture("afterCtx"),
    );
    git(repository, ["add", "arguments.go"]);
    git(repository, ["commit", "-m", "change call-site arguments"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runGoCallFlowRule({
      cwd: repository,
      from,
      to,
      paths: ["arguments.go"],
      changedPaths: ["arguments.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    });
    const nodes = flatten(result);
    const labels = nodes.map((node) => node.label);

    expect(labels).toContain("Handler.Resolved(afterCtx, role)");
    expect(labels).not.toContain("Handler.Resolved(declaredCtx, declaredRole)");
    expect(labels).toContain("repo.GetRole(childCtx)");
    expect(labels).toContain("cache.InsertRolePermission(childCtx, *role)");
    expect(labels).toContain("repo.Save(childCtx, *role)");
    expect(labels).toContain("repo.Store(firstArgument, secondArgument, …)");
    expect(labels).toContain("defer span.End()");
    expect(labels).toContain("defer wg.Done()");
    expect(labels).toContain("defer client.Close(role)");
    const longDependency = nodes.find(
      (node) =>
        node.kind === "dependency" && node.label.startsWith("collaborator."),
    );
    expect(longDependency?.label).toHaveLength(96);
    expect(longDependency?.label.endsWith("(…)")).toBe(true);
    expect(labels).toContain("defer func");
    expect(labels).toContain("Handler.Resolved(childCtx, role)");
    expect(labels).toContain("go");
    expect(labels).not.toContain("go()");
    expect(labels.every((label) => label.length <= 96)).toBe(true);

    const oldCall = nodes.find(
      (node) => node.label === "Handler.Resolved(beforeCtx, role)",
    );
    const newCall = nodes.find(
      (node) => node.label === "Handler.Resolved(afterCtx, role)",
    );
    expect(oldCall).toMatchObject({ status: "removed", children: [] });
    expect(newCall).toMatchObject({ status: "added", children: [] });
  });

  it("keeps existing callee bodies as context for added and removed edges", async () => {
    const repository = await createEmptyRepository("edge-diff");
    await writeFile(join(repository, "cache.go"), edgeDiffFixture("base"));
    git(repository, ["add", "cache.go"]);
    git(repository, ["commit", "-m", "base cache paths"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, "cache.go"), edgeDiffFixture("head"));
    git(repository, ["add", "cache.go"]);
    git(repository, ["commit", "-m", "change cache paths"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runGoCallFlowRule({
      cwd: repository,
      from,
      to,
      paths: ["cache.go"],
      changedPaths: ["cache.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    });
    const sync = result.trees.find(
      (tree) => tree.entry === "SyncRolePermissionCache",
    );
    const syncNodes = sync === undefined ? [] : flattenNode(sync.tree);
    const concurrent = syncNodes.find(
      (node) => node.kind === "concurrent" && node.label === "go",
    );
    const refresh = concurrent?.children.find((node) =>
      node.label.startsWith("RefreshRolePermissionCache"),
    );
    expect(concurrent?.status).toBe("added");
    expect(refresh?.status).toBe("added");
    expect(refresh?.children.map((node) => [node.label, node.status])).toEqual([
      ["stableBody()", "same"],
    ]);
    expect(refresh?.file).toBe("cache.go");
    expect(refresh?.line).toBeGreaterThan(0);

    const removed = result.trees.find(
      (tree) => tree.entry === "RemoveRolePermissionCache",
    );
    const removedConcurrent =
      removed === undefined
        ? undefined
        : flattenNode(removed.tree).find(
            (node) => node.kind === "concurrent" && node.status === "removed",
          );
    const removedRefresh = removedConcurrent?.children.find((node) =>
      node.label.startsWith("RefreshRolePermissionCache"),
    );
    expect(removedRefresh?.status).toBe("removed");
    expect(
      removedRefresh?.children.map((node) => [node.label, node.status]),
    ).toEqual([["stableBody()", "same"]]);

    const changed = result.trees.find(
      (tree) => tree.entry === "StartChangedRefresh",
    );
    const changedRefresh =
      changed === undefined
        ? undefined
        : flattenNode(changed.tree).find((node) =>
            node.label.startsWith("RefreshChanged"),
          );
    expect(changedRefresh?.status).toBe("added");
    expect(
      changedRefresh?.children.map((node) => [node.label, node.status]),
    ).toEqual([
      ["stableBody()", "same"],
      ["oldBody()", "removed"],
      ["newBody()", "added"],
    ]);
    const stopped = result.trees.find(
      (tree) => tree.entry === "StopChangedRefresh",
    );
    const stoppedRefresh =
      stopped === undefined
        ? undefined
        : flattenNode(stopped.tree).find((node) =>
            node.label.startsWith("RefreshChanged"),
          );
    expect(stoppedRefresh?.status).toBe("removed");
    expect(
      stoppedRefresh?.children.map((node) => [node.label, node.status]),
    ).toEqual([
      ["stableBody()", "same"],
      ["oldBody()", "removed"],
      ["newBody()", "added"],
    ]);
    const addedNewTarget = result.trees.find(
      (tree) => tree.entry === "AddNewTarget",
    );
    const newTarget = addedNewTarget?.tree.children.find((node) =>
      node.label.startsWith("newTarget"),
    );
    expect(newTarget).toMatchObject({ status: "added", children: [] });
    const removedOldTarget = result.trees.find(
      (tree) => tree.entry === "RemoveOldTarget",
    );
    const oldTarget = removedOldTarget?.tree.children.find((node) =>
      node.label.startsWith("oldTarget"),
    );
    expect(oldTarget).toMatchObject({ status: "removed", children: [] });
  });

  it("explains the compact PR-717 changed path from changed files", async () => {
    const repository = await createEmptyRepository("pr-717");
    await writeFile(join(repository, "review.go"), pr717Fixture("base"));
    await writeFile(join(repository, "auth.go"), AUTH_CALLERS);
    git(repository, ["add", "review.go", "auth.go"]);
    git(repository, ["commit", "-m", "base role permission cache"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, "review.go"), pr717Fixture("head"));
    git(repository, ["add", "review.go"]);
    git(repository, ["commit", "-m", "change role permission cache"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runGoCallFlowRule({
      cwd: repository,
      from,
      to,
      paths: ["auth.go", "review.go"],
      changedPaths: ["review.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    });

    expect(result.trees.map((tree) => tree.entry)).toEqual([
      "Server.OnInitialize",
    ]);
    const visible = projectChanged(result.trees[0]?.tree);
    expect(visible).toEqual({
      label: "Server.OnInitialize",
      status: "same",
      kind: "call",
      children: [
        {
          label: "Server.SyncRolePermissionCache",
          status: "same",
          kind: "call",
          children: [
            {
              label: "repo.GetRole",
              status: "removed",
              kind: "dependency",
              children: [],
            },
            {
              label: "cacheRepo.InsertRolePermission",
              status: "removed",
              kind: "dependency",
              children: [],
            },
            {
              label: "repo.GetRoleIDs",
              status: "added",
              kind: "dependency",
              children: [],
            },
            {
              label: "go",
              status: "added",
              kind: "concurrent",
              children: [
                {
                  label: "service.RefreshRolePermissionCache",
                  status: "added",
                  kind: "dependency",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });
    const nodes = flatten(result);
    expect(nodes.some((node) => node.kind === "branch")).toBe(false);
    expect(nodes.some((node) => node.label === "len")).toBe(false);
    expect(
      nodes.some((node) => ["Login", "LoginV2"].includes(node.label)),
    ).toBe(false);
    const refresh = nodes.find(
      (node) => node.label === "service.RefreshRolePermissionCache()",
    );
    expect(refresh?.children).toEqual([]);
  });

  it("falls back when changed files contain no affected definition", async () => {
    const repository = await createEmptyRepository("entry-fallback");
    await writeFile(join(repository, "flow.go"), fallbackFixture("base"));
    await writeFile(join(repository, "marker.go"), "package fallback\n");
    git(repository, ["add", "flow.go", "marker.go"]);
    git(repository, ["commit", "-m", "base fallback"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, "flow.go"), fallbackFixture("head"));
    await writeFile(
      join(repository, "marker.go"),
      "package fallback\n\n// metadata changed\n",
    );
    git(repository, ["add", "flow.go", "marker.go"]);
    git(repository, ["commit", "-m", "change fallback"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runGoCallFlowRule({
      cwd: repository,
      from,
      to,
      paths: ["flow.go", "marker.go"],
      changedPaths: ["marker.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    });

    expect(result.trees.map((tree) => tree.entry)).toEqual(["Run"]);
    expect(result.trees[0]?.tree.file).toBe("flow.go");
  });

  it("reduces an affected call cycle to one deterministic root", async () => {
    const repository = await createEmptyRepository("entry-cycle");
    await writeFile(join(repository, "cycle.go"), cycleFixture("base"));
    git(repository, ["add", "cycle.go"]);
    git(repository, ["commit", "-m", "base cycle"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repository, "cycle.go"), cycleFixture("head"));
    git(repository, ["add", "cycle.go"]);
    git(repository, ["commit", "-m", "change cycle"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();
    const options: GoCallFlowRuleOptions = {
      cwd: repository,
      from,
      to,
      paths: ["cycle.go"],
      changedPaths: ["cycle.go"],
      maxDepth: 12,
      color: false,
      locs: true,
    };

    const first = runGoCallFlowRule(options);
    expect(runGoCallFlowRule(options)).toEqual(first);
    expect(first.trees.map((tree) => tree.entry)).toEqual(["Alpha"]);
  });

  it("fails closed when one function exceeds the body-step budget", async () => {
    const repository = await createEmptyRepository("budget");
    await writeFile(
      join(repository, "budget.go"),
      "package budget\n\nfunc Run() { initial() }\n",
    );
    git(repository, ["add", "budget.go"]);
    git(repository, ["commit", "-m", "base budget"]);
    const from = git(repository, ["rev-parse", "HEAD"]).trim();
    const calls = Array.from(
      { length: 513 },
      (_, index) => `\tb.unknown${index}()`,
    ).join("\n");
    await writeFile(
      join(repository, "budget.go"),
      `package budget\n\ntype Budget struct{}\n\nfunc (b *Budget) Run() {\n${calls}\n}\n`,
    );
    git(repository, ["add", "budget.go"]);
    git(repository, ["commit", "-m", "exceed budget"]);
    const to = git(repository, ["rev-parse", "HEAD"]).trim();

    expect(() =>
      runGoCallFlowRule({
        cwd: repository,
        from,
        to,
        paths: ["budget.go"],
        changedPaths: ["budget.go"],
        maxDepth: 12,
        color: false,
        locs: true,
      }),
    ).toThrowError("GoCallFlowRuleBudgetExceeded:body-steps-per-function");
  });
});

const BASE_SOURCE = `package flow

type Gateway struct{ callback func() }
type Client struct{}

func (g *Gateway) Run(client *Client, fn func()) {
	g.send()
	legacy()
}

func (g *Gateway) send() {}
func legacy() {}
func fn() {}
func ready() bool { return true }
func ifWork() {}
func caseWork() {}
`;

const HEAD_SOURCE = `package flow

type Gateway struct{ callback func() }
type Client struct{}

func (g *Gateway) Run(client *Client, fn func()) {
	g.send()
	g.client.Send()
	g.unknown()
	client.Send()
	http.Get("https://example.test")
	pkg.Client.Send()
	other.send()
	fn()
	int(1)
	string([]byte{})
	LocalID(1)
	append(items, 1)
	cap(items)
	clear(mapping)
	close(ch)
	complex(1, 2)
	copy(items, items)
	delete(mapping, "key")
	imag(1i)
	len(items)
	make([]int, 1)
	max(1, 2)
	min(1, 2)
	new(int)
	panic("stop")
	print("value")
	println("value")
	real(1i)
	recover()
	method := g.send
	_ = method
	field := g.callback
	_ = field
	if ready() {
		ifWork()
	}
	switch classify() {
	case 1:
		caseWork()
	}
	go func() {
		asyncWork()
	}()
	defer func() {
		cleanup()
	}()
	defer cleanupDirect()
	defer g.client.Close()
	defer http.Get("https://example.test")
	defer wg.Done()
}

func (g *Gateway) send() {}
func asyncWork() {}
func cleanup() {}
func cleanupDirect() {}
func fn() {}
func ready() bool { return true }
func ifWork() {}
func caseWork() {}
`;

function packageFixture(
  packageName: string,
  prefix: string,
  revision: "Base" | "Head",
): string {
  return `package ${packageName}

type Service struct{}

func Run() { helper() }
func helper() { ${prefix}${revision}() }
func (s *Service) Refresh() { ${prefix}${revision}() }
func ${prefix}Base() {}
func ${prefix}Head() {}
`;
}

function genericFixture(callee: "Before" | "After"): string {
  return `package receivers

type Box[T any] struct{}

func (b *Box[T]) Generic() {
	b.Touch()
	method := b.Touch
	_ = method
	${callee}()
}
func (Box[T]) Unnamed() {
	other.Touch()
	${callee}()
}
func (b *Box[T]) Touch() {}
func Before() {}
func After() {}
`;
}

function signalFixture(revision: "base" | "head"): string {
  const collaborator = revision === "base" ? "Before" : "Refresh";
  const resolved = revision === "base" ? "resolvedBefore" : "resolvedAfter";
  return `package signal

type Handler struct{}

func (h *Handler) Run(fn func()) {
	h.svc.${collaborator}()
	log.Errorf("failure")
	fmt.Sprintf("value")
	observability.Record()
	tracing.Start()
	wg.Add(1)
	wg.Done()
	wg.Wait()
	refreshErrors.Add(1)
	refreshErrors.Load()
	fn()
	${resolved}()
	h.Handle()
	group.POST("/signal", h.Handle)
}
func (h *Handler) Handle() {}
func resolvedBefore() {}
func resolvedAfter() {}
`;
}

function argumentFixture(argument: "beforeCtx" | "afterCtx"): string {
  return `package arguments

type Context struct{}
type Role struct{}
type Handler struct{}

func (h *Handler) Run(childCtx Context, role *Role) {
	h.Resolved(${argument}, role)
	h.repo.GetRole(childCtx)
	h.cache.InsertRolePermission(childCtx, *role)
	h.repo.Save(
		// retain source comments without treating them as call arguments
		childCtx,
		/* role argument */ *role,
	)
	h.repo.Store(
		firstArgument,
		secondArgument,
		"012345678901234567890123456789012345678901234567890123456789",
	)
	go func() { h.Resolved(childCtx, role) }()
	defer h.span.End()
	defer h.wg.Done()
	h.collaborator.abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz()
	defer h.client.Close(/* close argument */ role)
	defer func() { h.Resolved(childCtx, role) }()
}

func (h *Handler) Resolved(declaredCtx Context, declaredRole *Role) { stable() }
func stable() {}
`;
}

function edgeDiffFixture(revision: "base" | "head"): string {
  const sync =
    revision === "base"
      ? "func SyncRolePermissionCache() { keep() }"
      : "func SyncRolePermissionCache() { keep(); go RefreshRolePermissionCache() }";
  const remove =
    revision === "base"
      ? "func RemoveRolePermissionCache() { keep(); go RefreshRolePermissionCache() }"
      : "func RemoveRolePermissionCache() { keep() }";
  const startChanged =
    revision === "base"
      ? "func StartChangedRefresh() { keep() }"
      : "func StartChangedRefresh() { keep(); go RefreshChanged() }";
  const stopChanged =
    revision === "base"
      ? "func StopChangedRefresh() { keep(); go RefreshChanged() }"
      : "func StopChangedRefresh() { keep() }";
  const changedBody =
    revision === "base"
      ? "func RefreshChanged() { stableBody(); oldBody() }"
      : "func RefreshChanged() { stableBody(); newBody() }";
  const newTargetPath =
    revision === "base"
      ? "func AddNewTarget() { keep() }"
      : "func AddNewTarget() { keep(); newTarget() }\nfunc newTarget() { stableBody() }";
  const oldTargetPath =
    revision === "base"
      ? "func RemoveOldTarget() { keep(); oldTarget() }\nfunc oldTarget() { stableBody() }"
      : "func RemoveOldTarget() { keep() }";
  return `package cache

${sync}
${remove}
${startChanged}
${stopChanged}
${newTargetPath}
${oldTargetPath}
func RefreshRolePermissionCache() { stableBody() }
${changedBody}
func keep() {}
func stableBody() {}
func oldBody() {}
func newBody() {}
`;
}

const AUTH_CALLERS = `package cache

func (s *Server) Login() { s.SyncRolePermissionCache() }
func (s *Server) LoginV2() { s.SyncRolePermissionCache() }
`;

function pr717Fixture(revision: "base" | "head"): string {
  const sync =
    revision === "base"
      ? `func (s *Server) SyncRolePermissionCache() {
	s.repo.GetRole()
	s.cacheRepo.InsertRolePermission()
}`
      : `func (s *Server) SyncRolePermissionCache() {
	ids := s.repo.GetRoleIDs()
	_ = len(ids)
	log.Infof("refresh")
	fmt.Sprintf("%v", ids)
	observability.Record()
	tracing.Start()
	wg.Add(1)
	refreshErrors.Load()
	go s.service.RefreshRolePermissionCache()
}`;
  return `package cache

type Server struct{}

func (s *Server) OnInitialize() { s.SyncRolePermissionCache() }
${sync}
`;
}

function fallbackFixture(revision: "base" | "head"): string {
  const callee = revision === "base" ? "before" : "after";
  return `package fallback

func Run() { ${callee}() }
func before() {}
func after() {}
`;
}

function cycleFixture(revision: "base" | "head"): string {
  const callee = revision === "base" ? "before" : "after";
  return `package cycle

func Alpha() { Beta(); ${callee}() }
func Beta() { Alpha() }
func before() {}
func after() {}
`;
}

async function createEmptyRepository(suffix: string): Promise<string> {
  const repository = await mkdtemp(
    join(tmpdir(), `patchdesk-go-rule-${suffix}-`),
  );
  temporaryRepositories.push(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "go-rule@example.test"]);
  git(repository, ["config", "user.name", "Go Rule Test"]);
  return repository;
}

async function createRepository(source: string): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "patchdesk-go-rule-"));
  temporaryRepositories.push(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "go-rule@example.test"]);
  git(repository, ["config", "user.name", "Go Rule Test"]);
  await writeFile(join(repository, "flow.go"), source);
  await writeFile(
    join(repository, "types.go"),
    "package flow\n\ntype LocalID int\n",
  );
  git(repository, ["add", "flow.go", "types.go"]);
  git(repository, ["commit", "-m", "base"]);
  return repository;
}

type VisibleChangedNode = {
  readonly label: string;
  readonly status: DiffNode["status"];
  readonly kind: DiffNode["kind"];
  readonly children: ReadonlyArray<VisibleChangedNode>;
};

function projectChanged(
  node: DiffNode | undefined,
): VisibleChangedNode | undefined {
  if (node === undefined) return undefined;
  const children = node.children.flatMap((child) => {
    const projected = projectChanged(child);
    return projected === undefined ? [] : [projected];
  });
  if (node.status === "same" && children.length === 0) return undefined;
  return {
    label: node.label.replace(/\(.*$/, ""),
    status: node.status,
    kind: node.kind,
    children,
  };
}

function flatten(result: DiffResult): ReadonlyArray<DiffNode> {
  const nodes: Array<DiffNode> = [];
  for (const tree of result.trees) nodes.push(...flattenNode(tree.tree));
  return nodes;
}

function flattenNode(root: DiffNode): ReadonlyArray<DiffNode> {
  const nodes: Array<DiffNode> = [];
  const visit = (node: DiffNode): void => {
    nodes.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return nodes;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
