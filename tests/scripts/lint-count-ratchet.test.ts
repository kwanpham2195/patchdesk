import { describe, expect, it } from "vitest";

import { lintStaged } from "../../scripts/lint-staged-lib.mjs";
import { createHarness } from "./lint-staged-harness";

/**
 * The Oxlint finding-count ratchet, as `lintStaged` runs it on a commit.
 *
 * Its sibling `check-knip-ratchet.test.ts` covers the same three rules for
 * Knip; both ratchets are one `runCountRatchet` in
 * `scripts/quality-ratchet-lib.mjs`, parameterised by a spec. What differs is
 * the entry point, which is why they are two files: these cases reach the
 * ratchet through the whole pre-commit gate and need its fixture, while the
 * Knip cases call the ratchet command directly.
 */
describe("lintStaged: the Oxlint finding-count ratchet", () => {
  it("fails when .oxlintrc.json is staged and lint-baseline.json is not in the change", async () => {
    // Loosening a rule lowers the repo-wide count on its own. Without this
    // gate the count ratchet would read the lower number as an improvement
    // and accept it as the new truth.
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0",
      existingPaths: new Set(),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not staged in this change.",
    );
    expect(harness.stderr.join("")).toContain("silently lowers");
    expect(harness.stderr.join("")).toContain(
      "accept the new lower number as the truth",
    );
    // It fails before paying for a repo-wide Oxlint run.
    expect(
      harness.calls.some(({ args }) => args.includes("--format=json")),
    ).toBe(false);
  });

  it("fails when an Oxlint plugin source is staged and lint-baseline.json is not in the change", async () => {
    // A rule written in plugin JavaScript can be weakened exactly the way a
    // rule written in .oxlintrc.json can.
    const harness = createHarness({
      stagedOutput: "tools/oxlint/anti-slop/index.ts\0",
      existingPaths: new Set(),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not staged in this change.",
    );
  });

  it("passes when .oxlintrc.json and lint-baseline.json are staged together", async () => {
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0lint-baseline.json\0",
      existingPaths: new Set(),
      baselineFindings: 3,
      ratchetDiagnosticsCount: 3,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.stderr.join("")).toBe("");
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Oxlint findings unchanged at 3",
    );
  });

  it("fails an .oxlintrc.json change staged alone, with the tracked baseline left untouched", async () => {
    // THE CASE THE RULE EXISTS FOR, and the one it used to let through. An
    // earlier form asked `git ls-files --stage -- lint-baseline.json` whether
    // the baseline was PRESENT. A tracked file is present unconditionally, so
    // that answer was "yes" for every change: three anti-slop rules could be
    // switched off, staged alone, and committed with every check green.
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0",
      existingPaths: new Set(),
      baselineFindings: 7,
      ratchetDiagnosticsCount: 7,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not staged in this change.",
    );
    expect(harness.stderr.join("")).toContain(
      "Staging lint-baseline.json unchanged does not count",
    );
    // It fails before paying for a repo-wide Oxlint run.
    expect(
      harness.calls.some(({ args }) => args.includes("--format=json")),
    ).toBe(false);
  });

  it("reads the changed-path list rather than asking git whether the baseline is tracked", async () => {
    // The changed-path list is `git diff --cached --name-only`, the change
    // itself. `ls-files`/`ls-tree` answer "is this file tracked", whose
    // answer never varies; the harness throws if anything reaches for one.
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0lint-baseline.json\0",
      existingPaths: new Set(),
      baselineFindings: 7,
      ratchetDiagnosticsCount: 7,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(
      harness.calls.some(
        ({ command, args }) =>
          command === "git" &&
          (args[0] === "ls-files" || args[0] === "ls-tree"),
      ),
    ).toBe(false);
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Oxlint findings unchanged at 7",
    );
  });

  it("does not catch a config change whose findings net back to the same count", async () => {
    // A KNOWN, DELIBERATE HOLE, recorded so nobody mistakes it for closed.
    // Loosening five findings away while adding five new ones leaves the
    // count where the baseline says it should be, so rule 3 passes it and
    // rule 2 has nothing to object to -- the baseline IS correct. No gate
    // that compares one number to one number can tell netting from no
    // change; catching it needs a baseline of finding identities, not of
    // finding totals. The previous content-difference form did not catch it
    // either: one character in an unused "note" field satisfied it.
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0lint-baseline.json\0",
      existingPaths: new Set(),
      baselineFindings: 5,
      ratchetDiagnosticsCount: 5,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Oxlint findings unchanged at 5",
    );
  });

  it("puts a staged deletion of an Oxlint plugin file through the configuration rule", async () => {
    // `--diff-filter=ACDMR` includes deletions, so removing a rule file is
    // seen as the configuration change it is. Under `ACMR` it was invisible.
    const harness = createHarness({
      stagedOutput: "tools/oxlint/anti-slop/rules/no-drift.ts\0",
      existingPaths: new Set(),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not staged in this change.",
    );
  });

  it("fails when the repo-wide count fell but the staged lint-baseline.json still holds the old number", async () => {
    // The baseline is read with `git show :lint-baseline.json`, so an edit
    // that was never staged reads as the old number and still fails. That
    // is what makes "update the baseline in the same commit" enforceable
    // rather than advice.
    const harness = createHarness({
      baselineFindings: 9,
      ratchetDiagnosticsCount: 4,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Repo-wide Oxlint findings fell from 9 to 4",
    );
    expect(harness.stderr.join("")).toContain(
      'Set "findings" in lint-baseline.json to 4',
    );
    expect(harness.stderr.join("")).toContain("unstaged edits count too");
  });

  it("fails when the repo-wide count rose above the staged baseline", async () => {
    const harness = createHarness({
      baselineFindings: 4,
      ratchetDiagnosticsCount: 5,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Repo-wide Oxlint findings rose from 4 to 5",
    );
  });
});
