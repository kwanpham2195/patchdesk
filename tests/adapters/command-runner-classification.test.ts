import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";

/**
 * Fixture-driven classifier tests (plan 007). Each file under
 * tests/fixtures/gh-command-failures/ records one real or synthetic child
 * process failure shape — captured against `gh 2.96.0`, see each fixture's
 * `capturedWith`/`synthetic` fields — and the CommandFailure tag
 * `classifyExecution` must produce for it.
 *
 * The corpus covers what a surviving child can still fail with. Every GitHub
 * API status and GraphQL error body moved to the HTTP transport's own tables
 * with the `gh api` child (ADR 0046):
 * `tests/adapters/github-http-client-failures.test.ts` for REST statuses and
 * `tests/adapters/github-graphql-errors.test.ts` for GraphQL error bodies.
 *
 * To regenerate a fixture after a `gh` upgrade changes wording: re-run its
 * recorded `command` with the new `gh` version, diff the actual stdout/stderr
 * against the fixture body, and update both the fixture and
 * capturedWith/capturedAt in the same commit as any classifier change. Never
 * update a fixture without re-verifying the real output it represents.
 */

const FIXTURES_DIR = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "gh-command-failures",
);

type Fixture = {
  readonly capturedWith: string;
  readonly capturedAt: string;
  readonly command: string;
  readonly synthetic: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly expectedTag: CommandFailure["_tag"];
  readonly expectedReason?: string;
  readonly note: string;
};

function loadFixture(name: string): Fixture {
  const raw = readFileSync(join(FIXTURES_DIR, name), "utf8");
  // SAFETY: test-only fixture loader reading from this repo's own
  // tests/fixtures directory, not external input; every fixture's shape is
  // exercised immediately below by driving it through the real classifier.
  return JSON.parse(raw) as Fixture;
}

function fixtureNames(): ReadonlyArray<string> {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

class FakeCommandExecutor implements CommandExecutor {
  constructor(private readonly execution: CommandExecution) {}

  execute(_input: CommandRequest): Promise<CommandExecution> {
    return Promise.resolve(this.execution);
  }
}

async function classify(fixture: Fixture): Promise<CommandFailure> {
  const executor = new FakeCommandExecutor({
    _tag: "Exited",
    exitCode: fixture.exitCode,
    stdout: fixture.stdout,
    stderr: fixture.stderr,
  });
  const result = await new CommandRunner(executor).runText({
    argv: ["gh"],
    timeoutMs: 1_000,
  });
  if (result._tag !== "err") {
    throw new Error(`fixture exit code ${fixture.exitCode} did not fail`);
  }
  return result.error;
}

describe("CommandRunner classifyExecution — fixture corpus", () => {
  const names = fixtureNames();

  it("covers every stderr predicate and the unclassified fallback", () => {
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of names) {
    it(`classifies ${name} as its recorded expectedTag`, async () => {
      const fixture = loadFixture(name);
      const failure = await classify(fixture);
      expect(failure._tag).toBe(fixture.expectedTag);
      if (fixture.expectedReason !== undefined) {
        expect(failure).toMatchObject({ reason: fixture.expectedReason });
      }
    });
  }
});

describe("CommandRunner — unclassified-failure telemetry hook", () => {
  it("invokes onUnclassifiedFailure when a nonzero-exit failure matches no stderr predicate", async () => {
    const onUnclassifiedFailure = vi.fn();
    const executor = new FakeCommandExecutor({
      _tag: "Exited",
      exitCode: 1,
      stdout: "",
      stderr: "gh: something totally unrecognized happened",
    });

    const result = await new CommandRunner(
      executor,
      onUnclassifiedFailure,
    ).runText({ argv: ["gh"], timeoutMs: 1_000 });

    expect(result).toEqual({
      _tag: "err",
      error: {
        _tag: "CommandFailed",
        stderr: "gh: something totally unrecognized happened",
      },
    });
    expect(onUnclassifiedFailure).toHaveBeenCalledTimes(1);
    expect(onUnclassifiedFailure).toHaveBeenCalledWith(
      "gh: something totally unrecognized happened",
    );
  });

  it("does not invoke onUnclassifiedFailure when a stderr predicate matches", async () => {
    const onUnclassifiedFailure = vi.fn();
    const executor = new FakeCommandExecutor({
      _tag: "Exited",
      exitCode: 1,
      stdout: "",
      stderr: "gh: not logged in",
    });

    await new CommandRunner(executor, onUnclassifiedFailure).runText({
      argv: ["gh"],
      timeoutMs: 1_000,
    });

    expect(onUnclassifiedFailure).not.toHaveBeenCalled();
  });

  it("defaults to a no-op hook when none is supplied", async () => {
    const executor = new FakeCommandExecutor({
      _tag: "Exited",
      exitCode: 1,
      stdout: "",
      stderr: "gh: something totally unrecognized happened",
    });

    await expect(
      new CommandRunner(executor).runText({ argv: ["gh"], timeoutMs: 1_000 }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "CommandFailed",
        stderr: "gh: something totally unrecognized happened",
      },
    });
  });
});
