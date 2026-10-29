import { describe, expect, it } from "vitest";

import { GITHUB_LOGIN_MAX_LENGTH, parseGitHubLogin } from "#src/domain/ids";
import {
  parseWorkspaceProfileConfig,
  parsePreSchemaWorkspaceProfile,
} from "#src/domain/workspace-profile";

const profile = {
  id: "fixture",
  label: "Fixture",
  schemaVersion: 1 as const,
  localRepositoryCatalogGeneration: "12345678-1234-4234-8234-123456789abc",
  github: {
    kind: "connected" as const,
    host: "github.com",
    account: "fixture",
  },

  rulePaths: [],
  repos: [],
};

describe("GitHub login bounds", () => {
  it("accepts GitHub's 39-character login maximum and rejects 40 characters", () => {
    expect(GITHUB_LOGIN_MAX_LENGTH).toBe(39);
    const maximum = "a".repeat(GITHUB_LOGIN_MAX_LENGTH);
    expect(parseGitHubLogin(maximum)).toEqual({
      _tag: "ok",
      value: maximum,
    });
    expect(parseGitHubLogin(`${maximum}a`)).toEqual({
      _tag: "err",
      error: { _tag: "InvalidDomainValue", field: "githubLogin" },
    });
  });

  it("rejects stored profiles whose account is not a bounded GitHub login", () => {
    const maximum = "a".repeat(GITHUB_LOGIN_MAX_LENGTH);
    expect(
      parseWorkspaceProfileConfig({
        ...profile,
        github: { ...profile.github, account: maximum },
      }),
    ).toMatchObject({ _tag: "ok", value: { github: { account: maximum } } });
    expect(
      parseWorkspaceProfileConfig({
        ...profile,
        github: { ...profile.github, account: `${maximum}a` },
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWorkspaceProfileConfig" },
    });
    expect(
      parseWorkspaceProfileConfig({
        ...profile,
        github: { ...profile.github, account: "invalid/login" },
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWorkspaceProfileConfig" },
    });
  });
});

describe("retired profile settings", () => {
  it("still loads a profile stored with the removed owner-filter key, dropping it", () => {
    const {
      schemaVersion: _schema,
      localRepositoryCatalogGeneration: _generation,
      github,
      ...legacy
    } = profile;
    const parsed = parsePreSchemaWorkspaceProfile({
      ...legacy,
      githubHost: github.host,
      ghAccount: github.account,
      ownerFilters: ["octo-org"],
    });

    expect(parsed).toMatchObject({ _tag: "ok", value: { id: "fixture" } });
    expect(parsed._tag === "ok" && "ownerFilters" in parsed.value).toBe(false);
  });

  it("rejects a stored profile carrying any other unknown key", () => {
    expect(
      parseWorkspaceProfileConfig({ ...profile, unexpected: "value" }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWorkspaceProfileConfig" },
    });
  });
});
