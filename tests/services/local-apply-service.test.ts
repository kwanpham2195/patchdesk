import { readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseLocalBranchName } from "../../src/domain/ids";
import { err } from "../../src/domain/result";
import {
  applyRequest,
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  profileId,
  retainAnalysis,
  suggestionFinding,
  value,
  type GitInterceptor,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const probe = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (let index = 0; index <= values.length; index += 1) {",
  "    total += values[index] ?? 0;",
  "  }",
  "  return total;",
  "}",
  "export const last = 1;",
].join("\n");
const boundFix = suggestionFinding(
  "finding-bound",
  "probe.ts",
  { start: 3, end: 3 },
  "  for (let index = 0; index < values.length; index += 1) {",
);
// The file has no final newline, so this replaces the line git marks "\ No newline at end of file".
const lastLineFix = suggestionFinding(
  "finding-last",
  "probe.ts",
  { start: 8, end: 8 },
  "export const last = 2;",
);

function isApplyWrite(argv: ReadonlyArray<string>): boolean {
  return argv.includes("apply") && !argv.includes("--check");
}

describe("LocalApplyService", () => {
  it("changes exactly the suggested lines and leaves the index and status untouched", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");
    await writeFile(join(repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [
      boundFix,
      lastLineFix,
    ]);
    // `git status` refreshes the index, so it runs before the bytes are read.
    const statusBefore = git(repositoryPath, "status", "--short");
    const indexPath = join(repositoryPath, ".git", "index");
    const indexBefore = await readFile(indexPath);

    const applied = value(
      await harness.service.apply(
        applyRequest(workbench, runId, ["finding-bound", "finding-last"]),
      ),
    );

    expect(await readFile(join(repositoryPath, "probe.ts"), "utf8")).toBe(
      probe
        .replace("index <= values.length", "index < values.length")
        .replace("last = 1;", "last = 2;"),
    );
    expect(await readFile(join(repositoryPath, "tracked.txt"), "utf8")).toBe(
      "two\n",
    );
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(git(repositoryPath, "status", "--short")).toBe(statusBefore);
    // The confirmed Apply moved the Review to a session of the applied checkout.
    expect(applied.status).toBe("applied");
    const next = applied.status === "applied" ? applied.workbench : undefined;
    expect(next?.session.id).not.toBe(workbench.session.id);
    expect(next?.fullPatch).toContain("+export const last = 2;");
    expect(next?.insights.analysis.status).not.toBe("current");
    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
  });

  it("refuses when the checkout changed after the Analysis run and records the new revision", async () => {
    const harness = await localApplyHarness();
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
    await writeFile(join(harness.repositoryPath, "tracked.txt"), "edited\n");

    const refused = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-bound"]),
    );

    expect(refused).toEqual(err({ reason: "revision_changed" }));
    expect(
      await readFile(join(harness.repositoryPath, "probe.ts"), "utf8"),
    ).toBe(probe);
    const review = value(
      await harness.reviews.load(profileId, workbench.review.id),
    );
    expect(review.freshness._tag).toBe("RevisionChanged");
    expect(
      review.freshness._tag === "RevisionChanged"
        ? review.freshness.identity.headSha
        : undefined,
    ).not.toBe(workbench.session.key.headSha);
    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
  });

  it("refuses Findings whose ranges share a line and writes nothing", async () => {
    const harness = await localApplyHarness();
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const overlapping = suggestionFinding(
      "finding-overlap",
      "probe.ts",
      { start: 3, end: 4 },
      "  for (const item of values) total += item;",
    );
    const runId = await retainAnalysis(harness.insights, workbench, [
      boundFix,
      overlapping,
    ]);

    const refused = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-bound", "finding-overlap"]),
    );

    expect(refused).toEqual(err({ reason: "overlapping" }));
    expect(
      await readFile(join(harness.repositoryPath, "probe.ts"), "utf8"),
    ).toBe(probe);
  });

  it("refuses a Review whose source is a branch", async () => {
    const harness = await localApplyHarness();
    git(harness.repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    git(harness.repositoryPath, "add", "probe.ts");
    git(harness.repositoryPath, "commit", "-q", "-m", "probe");
    const workbench = await harness.open({
      kind: "branch",
      branch: value(parseLocalBranchName("feature")),
      baseBranch: value(parseLocalBranchName("main")),
    });
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);

    const refused = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-bound"]),
    );

    expect(refused).toEqual(err({ reason: "not_working_tree" }));
  });

  it("refuses a file reached through a symlink", async () => {
    const harness = await localApplyHarness();
    const outside = join(dirname(harness.repositoryPath), "outside.ts");
    await writeFile(outside, "export const outside = 1;\n");
    await symlink(outside, join(harness.repositoryPath, "link.ts"));
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [
      suggestionFinding(
        "finding-link",
        "link.ts",
        { start: 1, end: 1 },
        "elsewhere",
      ),
    ]);

    const refused = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-link"]),
    );

    expect(refused).toEqual(err({ reason: "path_refused" }));
    expect(await readFile(outside, "utf8")).toBe("export const outside = 1;\n");
  });

  it("persists the intent before the check and outcome-unknown before git apply writes", async () => {
    const statesSeen: string[] = [];
    const harness = await localApplyHarness(async (argv, run) => {
      if (!argv.includes("apply")) return run();
      const [reviewId] = value(await harness.operations.listReviews(profileId));
      const stored =
        reviewId === undefined
          ? undefined
          : value(await harness.operations.load(profileId, reviewId));
      statesSeen.push(
        `${argv.includes("--check") ? "check" : "write"}:${stored?.state ?? "none"}`,
      );
      return run();
    });
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);

    value(
      await harness.service.apply(
        applyRequest(workbench, runId, ["finding-bound"]),
      ),
    );

    expect(statesSeen).toEqual(["check:Requested", "write:OutcomeUnknown"]);
  });
});

describe("LocalApplyService recovery", () => {
  const second = "export const second = 1;\n";
  const secondFix = suggestionFinding(
    "finding-second",
    "second.ts",
    { start: 1, end: 1 },
    "export const second = 2;",
  );

  it.each([
    {
      name: "confirms an Apply whose files all reached the post-image",
      crash: (async (_argv, run) => {
        await run();
        return err({ _tag: "GitReadFailed" as const });
      }) satisfies GitInterceptor,
      decision: "confirmed",
      remaining: undefined,
    },
    {
      name: "clears an Apply whose files all stayed at the pre-image",
      crash: (async () =>
        err({ _tag: "GitReadFailed" as const })) satisfies GitInterceptor,
      decision: "not_applied",
      remaining: undefined,
    },
    {
      name: "keeps an Apply locked when files are at neither image",
      crash: (async (argv, run) => {
        await run();
        const checkout = argv[2] ?? "";
        await writeFile(join(checkout, "second.ts"), second);
        return err({ _tag: "GitReadFailed" as const });
      }) satisfies GitInterceptor,
      decision: "check_required",
      remaining: "CheckRequired",
    },
  ])("$name at the next start", async ({ crash, decision, remaining }) => {
    let writes = 0;
    const harness = await localApplyHarness(async (argv, run) => {
      if (!isApplyWrite(argv)) return run();
      writes += 1;
      return crash(argv, run);
    });
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    await writeFile(join(harness.repositoryPath, "second.ts"), second);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [
      boundFix,
      secondFix,
    ]);
    const applied = value(
      await harness.service.apply(
        applyRequest(workbench, runId, ["finding-bound", "finding-second"]),
      ),
    );
    expect(applied).toEqual({ status: "outcome_unknown" });

    await harness.service.recoverAll();

    expect(writes).toBe(1);
    const settled = value(
      await harness.operations.load(profileId, workbench.review.id),
    );
    expect(settled?.state).toBe(remaining);
    expect(
      harness.logs.filter(
        (entry) => entry.message === "Local apply recovery decided",
      ),
    ).toEqual([
      expect.objectContaining({
        topic: "local-apply",
        meta: expect.objectContaining({ decision, trigger: "startup" }),
      }),
    ]);
  });
});
