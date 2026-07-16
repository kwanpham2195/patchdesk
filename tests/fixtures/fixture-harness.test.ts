import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const fixtureRoot = join(import.meta.dirname, "..", "..", "fixtures");

const requiredScenarioNames = [
  "happy-path",
  "stale-head",
  "unmapped-findings",
  "check-blocked",
  "conflicting",
  "dirty-main-checkout",
  "missing-local-path",
  "invalid-flue-json",
  "missing-auth",
  "deleted-line-finding",
  "renamed-file-finding",
  "pure-rename",
  "omitted-large-patch",
  "binary-file",
  "archived-repo",
  "no-open-prs",
  "disconnected-flue-stream",
  "pending-review-api-rejection",
  "submit-failure",
  "merge-method-unsupported",
] as const;

const requiredScreens = [
  "dashboard",
  "launch",
  "in-progress-workbench",
  "completed-workbench",
  "draft-sheet",
  "submit-dialog",
  "merge-confirmation",
  "history",
  "settings",
] as const;

describe("Patchdesk fixture harness", () => {
  it.each(requiredScenarioNames)(
    "has a safe named %s scenario input",
    async (name) => {
      const contents = await readFile(
        join(fixtureRoot, "scenarios", name, "input.json"),
        "utf8",
      );

      expect(() => JSON.parse(contents)).not.toThrow();
      expect(contents).not.toMatch(
        /(?:token|secret|authorization|cookie|password)/i,
      );
      expect(contents).not.toMatch(/-----BEGIN|ghp_[A-Za-z0-9]/);
    },
  );

  it.each(requiredScreens)(
    "defines loading, degraded, error, and success coverage for %s",
    async (screen) => {
      const matrix = JSON.parse(
        await readFile(
          join(fixtureRoot, "screen-states", "matrix.json"),
          "utf8",
        ),
      ) as {
        readonly screens: ReadonlyArray<{
          readonly screen: string;
          readonly states: ReadonlyArray<string>;
        }>;
      };
      const entry = matrix.screens.find(
        (candidate) => candidate.screen === screen,
      );

      expect(entry?.states).toEqual([
        "loading",
        "degraded",
        "error",
        "success",
      ]);
    },
  );
});
