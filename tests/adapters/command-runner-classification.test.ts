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
 * tests/fixtures/gh-command-failures/ records one real or synthetic `gh`
 * failure shape — captured against `gh 2.96.0`, see each fixture's
 * `capturedWith`/`synthetic` fields — and the CommandFailure tag
 * `classifyExecution` must produce for it.
 *
 * To regenerate a fixture after a `gh` upgrade changes wording: re-run its
 * recorded `command` with the new `gh` version, diff the actual stdout/stderr
 * against the fixture body, and update both the fixture and
 * capturedWith/capturedAt in the same commit as any classifier change. Never
 * update a fixture without re-verifying the real `gh` output it represents.
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

  it("covers at least one fixture per predicate/structured path (corpus sanity check)", () => {
    expect(names.length).toBeGreaterThanOrEqual(11);
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

describe("CommandRunner classifyExecution — named regressions (plan 007 Why This Matters)", () => {
  it("classifies a 403 rate-limit response as CommandRateLimited, not CommandForbidden", async () => {
    const failure = await classify(loadFixture("rate-limit-403.json"));
    expect(failure).toEqual({ _tag: "CommandRateLimited" });
  });

  it("classifies an invalid/expired token (401 Bad credentials) as CommandAuthenticationRequired", async () => {
    const failure = await classify(loadFixture("bad-credentials-401.json"));
    expect(failure).toEqual({ _tag: "CommandAuthenticationRequired" });
  });
});

describe("CommandRunner classifyExecution — forbidden reasons (plan 009)", () => {
  it("classifies the live OmisePayments IP-allow-list failure as CommandForbidden/ip_allow_list", async () => {
    const failure = await classify(
      loadFixture("graphql-forbidden-ip-allow-list.json"),
    );
    expect(failure).toEqual({
      _tag: "CommandForbidden",
      reason: "ip_allow_list",
    });
  });

  it("classifies a saml_failure:true GraphQL response as CommandForbidden/saml regardless of message wording", async () => {
    const failure = await classify(loadFixture("graphql-forbidden-saml.json"));
    expect(failure).toEqual({ _tag: "CommandForbidden", reason: "saml" });
  });

  it("classifies INSUFFICIENT_SCOPES as CommandForbidden/insufficient_scopes", async () => {
    const failure = await classify(
      loadFixture("graphql-insufficient-scopes.json"),
    );
    expect(failure).toEqual({
      _tag: "CommandForbidden",
      reason: "insufficient_scopes",
    });
  });

  it("classifies an unattributed forbidden as CommandForbidden/unknown, not a guess", async () => {
    const failure = await classify(loadFixture("graphql-forbidden.json"));
    expect(failure).toEqual({ _tag: "CommandForbidden", reason: "unknown" });
  });

  it("classifies the REST IP-allow-list shape the same as the GraphQL one", async () => {
    const failure = await classify(
      loadFixture("rest-forbidden-ip-allow-list.json"),
    );
    expect(failure).toEqual({
      _tag: "CommandForbidden",
      reason: "ip_allow_list",
    });
  });
});

describe("CommandRunner — unclassified-failure telemetry hook", () => {
  it("invokes onUnclassifiedFailure when a nonzero-exit failure matches neither a structured signal nor a regex predicate", async () => {
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

  it("does not invoke onUnclassifiedFailure when a regex predicate matches", async () => {
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

  it("does not invoke onUnclassifiedFailure when a structured REST signal matches", async () => {
    const onUnclassifiedFailure = vi.fn();
    const fixture = loadFixture("not-found-404.json");
    const executor = new FakeCommandExecutor({
      _tag: "Exited",
      exitCode: fixture.exitCode,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
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

describe("CommandRunner classifyExecution — structured signal precedence", () => {
  it("prefers the REST structured signal over a graphql-shaped errors array in the same body", async () => {
    // A REST 422 validation body legitimately has both a string `status`
    // field and an `errors` array (see unsupported-422.json) — the same key
    // GraphQL uses for its error list. The REST path must win because
    // `status` is present, not get misrouted into the GraphQL branch.
    const failure = await classify(loadFixture("unsupported-422.json"));
    expect(failure).toEqual({ _tag: "CommandUnsupported" });
  });

  it("does not misclassify the non-gh pi-insight child's failure shape", async () => {
    const failure = await classify(
      loadFixture("runtime-unavailable-regex.json"),
    );
    expect(failure).toEqual({ _tag: "CommandRuntimeUnavailable" });
  });
});
