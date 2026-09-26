import { access, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseAbsolutePath,
  parseFindingId,
  parseLocalBranchName,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { dismissInsightFinding } from "../../src/domain/insight-record";
import { err } from "../../src/domain/result";
import {
  applyRequest,
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  now,
  profileId,
  retainAnalysis,
  suggestionFinding,
  value,
  type GitInterceptor,
  type LocalApplyHarness,
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

/** Opens the working tree of a new linked worktree `linked` holding `probe.ts`, which the configured checkout lacks (#489). */
async function openLinkedProbe(harness: LocalApplyHarness) {
  const linked = join(dirname(harness.repositoryPath), "linked");
  git(harness.repositoryPath, "worktree", "add", "-q", linked, "-b", "feat");
  await writeFile(join(linked, "probe.ts"), probe);
  const workbench = await harness.open({
    kind: "working_tree",
    checkout: value(parseAbsolutePath(linked)),
  });
  return { linked, workbench };
}

/** An Apply whose `git apply` wrote its files and then reported failure, so it is left outcome-unknown. */
const landsThenFails: GitInterceptor = async (argv, run) => {
  if (!isApplyWrite(argv)) return run();
  await run();
  return err({ _tag: "GitReadFailed" as const });
};

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

  it("refuses a dismissed Finding and writes nothing", async () => {
    const harness = await localApplyHarness();
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
    value(
      await harness.insights.mutate({
        profileId,
        reviewId: workbench.review.id,
        type: "analysis",
        now,
        operation: (record) =>
          dismissInsightFinding(
            record,
            value(parseFindingId("finding-bound")),
            "Accepted risk",
            now,
          ),
      }),
    );

    const refused = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-bound"]),
    );

    expect(refused).toEqual(err({ reason: "not_applicable" }));
    expect(
      await readFile(join(harness.repositoryPath, "probe.ts"), "utf8"),
    ).toBe(probe);
  });

  it("applies to the linked worktree a Review names and leaves the configured checkout alone (#489)", async () => {
    const harness = await localApplyHarness();
    const { linked, workbench } = await openLinkedProbe(harness);
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);

    const applied = value(
      await harness.service.apply(
        applyRequest(workbench, runId, ["finding-bound"]),
      ),
    );

    expect(applied.status).toBe("applied");
    expect(await readFile(join(linked, "probe.ts"), "utf8")).toBe(
      probe.replace("index <= values.length", "index < values.length"),
    );
    await expect(
      access(join(harness.repositoryPath, "probe.ts")),
    ).rejects.toThrow();
    const next = applied.status === "applied" ? applied.workbench : undefined;
    expect(next?.review.id).toBe(workbench.review.id);
    expect(next?.fullPatch).toContain("index < values.length");
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

describe("LocalApplyService refusals that write nothing", () => {
  it.each([
    {
      name: "a file git would write with CRLF line endings",
      configure: async (repositoryPath: string) =>
        writeFile(
          join(repositoryPath, ".gitattributes"),
          "*.ts text eol=crlf\n",
        ),
    },
    {
      name: "a text file under core.autocrlf=true",
      configure: async (repositoryPath: string) => {
        git(repositoryPath, "config", "core.autocrlf", "true");
      },
    },
  ])("refuses $name before any intent is stored", async ({ configure }) => {
    const harness = await localApplyHarness();
    await configure(harness.repositoryPath);
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);

    const refused = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-bound"]),
    );

    expect(refused).toEqual(err({ reason: "working_tree_conversion" }));
    expect(
      await readFile(join(harness.repositoryPath, "probe.ts"), "utf8"),
    ).toBe(probe);
    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "git apply --check refuses",
      check: (async () =>
        err({ _tag: "GitReadFailed" as const })) satisfies GitInterceptor,
      reason: "check_failed",
    },
    {
      name: "the file changes after the patch was composed",
      check: (async (argv, run) => {
        const checked = await run();
        await writeFile(join(argv[2] ?? "", "probe.ts"), `${probe}\n// edited`);
        return checked;
      }) satisfies GitInterceptor,
      reason: "file_changed",
    },
  ])("removes the intent when $name", async ({ check, reason }) => {
    let writes = 0;
    const harness = await localApplyHarness(async (argv, run) => {
      if (argv.includes("--check")) return check(argv, run);
      if (isApplyWrite(argv)) writes += 1;
      return run();
    });
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);

    const refused = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-bound"]),
    );

    expect(refused).toEqual(err({ reason }));
    expect(writes).toBe(0);
    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
  });
});

describe("LocalApplyService after confirmation", () => {
  it("marks the drafted Finding it applied, carries the other drafts to the next session, and leaves the applied one out of the agent prompt", async () => {
    const harness = await localApplyHarness();
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
    const key = {
      profileId,
      reviewId: workbench.review.id,
      sessionId: workbench.session.id,
    };
    value(
      await harness.drafts.add({
        ...key,
        runId,
        findingId: value(parseFindingId("finding-bound")),
      }),
    );
    value(
      await harness.drafts.addNote({
        ...key,
        anchor: {
          path: value(parseRepoRelativePath("probe.ts")),
          side: "new",
          startLine: 6,
          line: 6,
        },
        text: "Return early for an empty list.",
      }),
    );

    const applied = value(
      await harness.service.apply(
        applyRequest(workbench, runId, ["finding-bound"]),
      ),
    );

    const next = applied.status === "applied" ? applied.workbench : undefined;
    expect(next?.session.id).not.toBe(workbench.session.id);
    expect(next?.localDrafts).toEqual([
      expect.objectContaining({
        kind: "finding",
        findingId: "finding-bound",
        state: "applied",
      }),
      expect.objectContaining({
        kind: "note",
        sessionId: next?.session.id,
        startLine: 6,
        state: "unchanged",
      }),
    ]);
    const prompt = value(
      await harness.drafts.agentPrompt(profileId, workbench.review.id),
    ).markdown;
    expect(prompt).toContain("Return early for an empty list.");
    expect(prompt).not.toContain(boundFix.title);
  });

  it("reports a confirmed Apply as applied and leaves no lock when the next session cannot be prepared", async () => {
    const harness = await localApplyHarness(undefined, {
      opening: () => ({
        openLocked: async () => {
          throw new Error("preparation crashed");
        },
      }),
    });
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);

    const applied = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-bound"]),
    );

    expect(applied).toEqual({ _tag: "ok", value: { status: "applied" } });
    expect(
      await readFile(join(harness.repositoryPath, "probe.ts"), "utf8"),
    ).toBe(probe.replace("index <= values.length", "index < values.length"));
    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
  });

  it("keeps the lock when confirmation cannot be saved, and recovery confirms from the hashes", async () => {
    let confirmationSaves = "failing";
    const harness = await localApplyHarness(undefined, {
      operations: (store) => ({
        load: (profile, review) => store.load(profile, review),
        begin: (operation) => store.begin(operation),
        remove: (profile, review) => store.remove(profile, review),
        listReviews: (profile) => store.listReviews(profile),
        save: async (operation) =>
          operation.state === "Confirmed" && confirmationSaves === "failing"
            ? err({
                _tag: "StorageFailure" as const,
                operation: "write" as const,
                reason: "io" as const,
              })
            : store.save(operation),
      }),
    });
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);

    const applied = value(
      await harness.service.apply(
        applyRequest(workbench, runId, ["finding-bound"]),
      ),
    );
    expect(applied).toEqual({ status: "outcome_unknown" });
    expect(
      value(await harness.operations.load(profileId, workbench.review.id))
        ?.state,
    ).toBe("OutcomeUnknown");

    confirmationSaves = "working";
    await harness.service.recoverAll();

    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
    expect(
      harness.logs.find(
        (entry) => entry.message === "Local apply recovery decided",
      )?.meta,
    ).toEqual(expect.objectContaining({ decision: "confirmed" }));
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

describe("LocalApplyService recovery in a linked worktree (#489)", () => {
  it("confirms at the next start an Apply that landed in the linked worktree, reading that checkout", async () => {
    const harness = await localApplyHarness(landsThenFails);
    const { linked, workbench } = await openLinkedProbe(harness);
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
    expect(
      value(
        await harness.service.apply(
          applyRequest(workbench, runId, ["finding-bound"]),
        ),
      ),
    ).toEqual({ status: "outcome_unknown" });

    await harness.service.recoverAll();

    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
    expect(
      harness.logs.find(
        (entry) => entry.message === "Local apply recovery decided",
      )?.meta,
    ).toEqual(expect.objectContaining({ decision: "confirmed" }));
    expect(await readFile(join(linked, "probe.ts"), "utf8")).toContain(
      "index < values.length",
    );
    await expect(
      access(join(harness.repositoryPath, "probe.ts")),
    ).rejects.toThrow();
  });
});

describe("LocalApplyService after a move to another session (#484)", () => {
  it("settles a CheckRequired Apply on Refresh, so a new Apply succeeds and the old session is pruned", async () => {
    let agentWrote = false;
    const harness = await localApplyHarness(async (argv, run) => {
      if (!isApplyWrite(argv) || agentWrote) return run();
      // The agent writes the file between `git apply --check` and `git apply`.
      agentWrote = true;
      await writeFile(
        join(argv[2] ?? "", "probe.ts"),
        `${probe}\nexport const agent = 1;`,
      );
      return run();
    });
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
    expect(
      value(
        await harness.service.apply(
          applyRequest(workbench, runId, ["finding-bound"]),
        ),
      ),
    ).toEqual({ status: "outcome_unknown" });
    expect(
      value(await harness.service.recover(profileId, workbench.review.id)),
    ).toEqual({ decision: "check_required" });

    const refreshed = value(
      await harness.opening.refresh(profileId, workbench.review.id),
    );

    expect(refreshed.session.id).not.toBe(workbench.session.id);
    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
    expect(
      harness.logs.find(
        (entry) =>
          entry.message === "Local apply settled by a move to another session",
      ),
    ).toMatchObject({
      level: "warn",
      sessionId: workbench.session.id,
      meta: expect.objectContaining({
        state: "CheckRequired",
        decision: "check_required",
      }),
    });
    expect(
      git(
        harness.repositoryPath,
        "for-each-ref",
        "--format=%(refname)",
        "refs/patchdesk/local/",
      ).trim(),
    ).toBe(`refs/patchdesk/local/${profileId}/${refreshed.session.id}/head`);
    const nextRun = await retainAnalysis(harness.insights, refreshed, [
      lastLineFix,
    ]);
    const applied = await harness.service.apply(
      applyRequest(refreshed, nextRun, ["finding-last"]),
    );
    expect(value(applied).status).toBe("applied");
    expect(
      await readFile(join(harness.repositoryPath, "probe.ts"), "utf8"),
    ).toContain("export const last = 2;");
  });

  it("marks the drafted Finding applied when Refresh finds an unknown Apply landed", async () => {
    const harness = await localApplyHarness(async (argv, run) => {
      if (!isApplyWrite(argv)) return run();
      await run();
      return err({ _tag: "GitReadFailed" as const });
    });
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
    value(
      await harness.drafts.add({
        profileId,
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        runId,
        findingId: value(parseFindingId("finding-bound")),
      }),
    );
    expect(
      value(
        await harness.service.apply(
          applyRequest(workbench, runId, ["finding-bound"]),
        ),
      ),
    ).toEqual({ status: "outcome_unknown" });

    const refreshed = value(
      await harness.opening.refresh(profileId, workbench.review.id),
    );

    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
    expect(refreshed.localDrafts).toEqual([
      expect.objectContaining({ findingId: "finding-bound", state: "applied" }),
    ]);
  });

  it("marks the drafted Finding applied when Refresh of a linked worktree finds its unknown Apply landed (#489)", async () => {
    const harness = await localApplyHarness(landsThenFails);
    const { workbench } = await openLinkedProbe(harness);
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
    value(
      await harness.drafts.add({
        profileId,
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        runId,
        findingId: value(parseFindingId("finding-bound")),
      }),
    );
    expect(
      value(
        await harness.service.apply(
          applyRequest(workbench, runId, ["finding-bound"]),
        ),
      ),
    ).toEqual({ status: "outcome_unknown" });

    const refreshed = value(
      await harness.opening.refresh(profileId, workbench.review.id),
    );

    expect(refreshed.session.id).not.toBe(workbench.session.id);
    expect(
      value(await harness.operations.load(profileId, workbench.review.id)),
    ).toBeUndefined();
    expect(refreshed.localDrafts).toEqual([
      expect.objectContaining({ findingId: "finding-bound", state: "applied" }),
    ]);
  });

  it("keeps an unknown Apply locked when Refresh finds the same session", async () => {
    const harness = await localApplyHarness(async (argv, run) =>
      isApplyWrite(argv) ? err({ _tag: "GitReadFailed" as const }) : run(),
    );
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
    const request = applyRequest(workbench, runId, ["finding-bound"]);
    expect(value(await harness.service.apply(request))).toEqual({
      status: "outcome_unknown",
    });

    const refreshed = value(
      await harness.opening.refresh(profileId, workbench.review.id),
    );

    expect(refreshed.session.id).toBe(workbench.session.id);
    expect(
      value(await harness.operations.load(profileId, workbench.review.id))
        ?.state,
    ).toBe("OutcomeUnknown");
    expect(await harness.service.apply(request)).toEqual(
      err({ reason: "apply_locked" }),
    );
  });
});
