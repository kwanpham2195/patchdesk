import { describe, expect, it } from "vitest";
import { providerCredentialEnvironmentNames } from "#src/adapters/process/provider-credential-environment";

describe("provider environment allowlist", () => {
  it("collects every provider credential name once, and nothing else", async () => {
    const names = providerCredentialEnvironmentNames();

    expect(names).toContain("DEEPSEEK_API_KEY");
    expect(names).toContain("CLOUDFLARE_GATEWAY_ID");
    expect(names).toContain("AWS_PROFILE");
    expect(names).toContain("GOOGLE_CLOUD_PROJECT");
    expect(names).not.toContain("GH_TOKEN");
    expect(names).not.toContain("PATH");
    // MOONSHOT_API_KEY belongs to two providers; the allowlist lists it once.
    expect(new Set(names).size).toBe(names.length);
  });
});
