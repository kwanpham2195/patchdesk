import { describe, expect, it } from "vitest";

import { resolveMacSigningEnvironment } from "../../scripts/package-mac-lib.mjs";

describe("resolveMacSigningEnvironment", () => {
  it("turns signing off when there is no certificate", () => {
    const signing = resolveMacSigningEnvironment({ PATH: "/usr/bin" });

    expect(signing.mode).toBe("unsigned");
    expect(signing.notarized).toBe(false);
    // Without this, a machine whose keychain holds a Developer ID would start
    // signing on its own and prompt for the keychain password.
    expect(signing.environment.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(signing.environment.PATH).toBe("/usr/bin");
  });

  it("reads an unconfigured GitHub Actions secret as no certificate at all", () => {
    const signing = resolveMacSigningEnvironment({
      CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
      APPLE_ID: "",
    });

    expect(signing.mode).toBe("unsigned");
    // electron-builder accepts an empty CSC_LINK as "sign with this", which
    // would fail the build rather than produce the unsigned app.
    expect(Object.hasOwn(signing.environment, "CSC_LINK")).toBe(false);
    expect(Object.hasOwn(signing.environment, "APPLE_ID")).toBe(false);
  });

  it("signs with a certificate and leaves identity discovery to electron-builder", () => {
    const signing = resolveMacSigningEnvironment({
      CSC_LINK: "base64-certificate",
      CSC_KEY_PASSWORD: "secret",
    });

    expect(signing.mode).toBe("developer-id");
    expect(signing.notarized).toBe(false);
    expect(signing.summary).toContain("Notarization is skipped");
    expect(
      Object.hasOwn(signing.environment, "CSC_IDENTITY_AUTO_DISCOVERY"),
    ).toBe(false);
  });

  it("notarizes only when all three Apple credentials are set", () => {
    const signing = resolveMacSigningEnvironment({
      CSC_LINK: "base64-certificate",
      CSC_KEY_PASSWORD: "secret",
      APPLE_ID: "releases@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-specific",
      APPLE_TEAM_ID: "TEAMID1234",
    });

    expect(signing.mode).toBe("developer-id");
    expect(signing.notarized).toBe(true);
  });
});
