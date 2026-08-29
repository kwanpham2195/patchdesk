// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  forbiddenCopy,
  rateLimitedCopy,
} from "../../src/renderer/src/flows/inbox-flow";

const repo = { owner: "OmisePayments", repo: "dynamic-onboarding-service" };

describe("forbiddenCopy", () => {
  // ADR 0024: a forbidden read is attributed to one of a closed set of
  // reasons, and each reason names the condition and what the maintainer
  // must actually do. None of them resolve by asking again, so none of this
  // copy calls the condition temporary or invites a retry.
  it.each([
    ["ip_allow_list", "IP allow list"],
    ["saml", "SAML single sign-on"],
    ["insufficient_scopes", "scopes"],
  ])(
    "names the %s condition and the organization it applies to",
    (reason, condition) => {
      const copy = forbiddenCopy(reason, repo);
      expect(copy).toContain(condition);
      expect(copy).toContain(repo.owner);
      expect(copy).not.toMatch(/temporar/i);
    },
  );

  it("names the repository and admits it does not know why when the reason is unattributed", () => {
    const copy = forbiddenCopy(undefined, repo);
    expect(copy).toContain("did not say why");
    expect(copy).toContain(`${repo.owner}/${repo.repo}`);
  });

  it("falls back to the unattributed copy for a reason outside the closed set", () => {
    expect(forbiddenCopy("something_new", repo)).toBe(
      forbiddenCopy(undefined, repo),
    );
  });

  it("says the block is not necessarily temporary only for the unattributed reason", () => {
    // The three attributed reasons each name a concrete fix, so they promise
    // Patchdesk picks the read up again once access is restored; the
    // unattributed one cannot promise that.
    expect(forbiddenCopy(undefined, repo)).toContain("not necessarily");
    expect(forbiddenCopy("saml", repo)).toContain("once access is restored");
  });
});

describe("rateLimitedCopy", () => {
  it("states the resume time GitHub reported, in the maintainer's own locale (ADR 0023)", () => {
    const resumeAt = "2026-08-01T05:00:00.000Z";
    const formatted = new Date(resumeAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    const copy = rateLimitedCopy(resumeAt);
    expect(copy).toContain("GitHub rate-limited this account");
    expect(copy).toContain(formatted);
  });

  it("promises an automatic resume without a time when none was learned", () => {
    expect(rateLimitedCopy(undefined)).toContain(
      "resume automatically once the limit clears",
    );
  });

  it("falls back to the timeless copy rather than printing Invalid Date", () => {
    const copy = rateLimitedCopy("not-a-timestamp");
    expect(copy).toBe(rateLimitedCopy(undefined));
    expect(copy).not.toContain("Invalid");
  });

  it("never invites a retry, since retrying into an active limit only makes it worse", () => {
    for (const copy of [
      rateLimitedCopy("2026-08-01T05:00:00.000Z"),
      rateLimitedCopy(undefined),
    ]) {
      expect(copy).not.toMatch(/retry|try again/i);
    }
  });
});
