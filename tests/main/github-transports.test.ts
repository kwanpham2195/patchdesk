import { afterEach, describe, expect, it, vi } from "vitest";

import { githubTransports } from "../../src/main/local-api-stores";
import { StubCredentials } from "../adapters/stub-github-credentials";

/**
 * Which transports one launch builds. Both switches are read here rather than
 * per call, so this is the only place the rollback can be observed (ADR 0046,
 * issue #276).
 */

const logs = { write: () => undefined };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("githubTransports", () => {
  it("serves the allowlisted reads over HTTP by default", () => {
    const transports = githubTransports(new StubCredentials(), logs, undefined);

    expect(transports.http).toBeDefined();
    expect(transports.shadow).toBeUndefined();
  });

  it("puts every read back on gh when the launch asked for the rollback", () => {
    vi.stubEnv("PATCHDESK_GITHUB_TRANSPORT", "gh");

    expect(
      githubTransports(new StubCredentials(), logs, undefined).http,
    ).toBeUndefined();
  });

  it("builds the shadow only when the launch asked for one", () => {
    vi.stubEnv("PATCHDESK_TRANSPORT_SHADOW", "1");

    expect(
      githubTransports(new StubCredentials(), logs, undefined).shadow,
    ).toBeDefined();
  });

  it("still shadows the reads left on gh under the rollback", () => {
    vi.stubEnv("PATCHDESK_GITHUB_TRANSPORT", "gh");
    vi.stubEnv("PATCHDESK_TRANSPORT_SHADOW", "1");

    const transports = githubTransports(new StubCredentials(), logs, undefined);

    expect(transports.http).toBeUndefined();
    expect(transports.shadow).toBeDefined();
  });
});
