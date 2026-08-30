import { describe, expect, it } from "vitest";

import {
  GITHUB_LOGIN_MAX_LENGTH,
  parseGitHubLogin,
} from "../../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

const profile = {
  id: "fixture",
  label: "Fixture",
  githubHost: "github.com",
  ghAccount: "fixture",
  ownerFilters: [],
  workspaceRoots: [],
  rulePaths: [],
  repos: [],
};

describe("GitHub login bounds", () => {
  it("accepts GitHub's 39-character login maximum and rejects 40 characters", () => {
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
      parseWorkspaceProfileConfig({ ...profile, ghAccount: maximum }),
    ).toMatchObject({ _tag: "ok", value: { ghAccount: maximum } });
    expect(
      parseWorkspaceProfileConfig({ ...profile, ghAccount: `${maximum}a` }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWorkspaceProfileConfig" },
    });
    expect(
      parseWorkspaceProfileConfig({ ...profile, ghAccount: "invalid/login" }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWorkspaceProfileConfig" },
    });
  });
});
