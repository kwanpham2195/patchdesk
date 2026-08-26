import { describe, expect, it } from "vitest";

import {
  groupWatchlistEntries,
  mergeWatchlistEntries,
} from "../../src/renderer/src/flows/settings-workspace-repositories";
import type { Repo } from "../../src/renderer/src/renderer-models";

describe("mergeWatchlistEntries + groupWatchlistEntries", () => {
  it("groups a watched repository whose localPath is inside a saved root under that root, not into other", () => {
    const watchedRepos: ReadonlyArray<Repo> = [
      {
        host: "github.com",
        owner: "centraldigital",
        repo: "cfw-sales-crm-api",
        localPath: "/Users/kwanpham/Work/cfw/cfw-sales-crm-api",
      },
    ];
    const entries = mergeWatchlistEntries([], watchedRepos);
    const { byRoot, other } = groupWatchlistEntries(entries, [
      "/Users/kwanpham/Work/cfw",
    ]);

    expect(other).toEqual([]);
    expect(byRoot.get("/Users/kwanpham/Work/cfw")).toEqual([
      {
        host: "github.com",
        owner: "centraldigital",
        repo: "cfw-sales-crm-api",
        localPath: "/Users/kwanpham/Work/cfw/cfw-sales-crm-api",
      },
    ]);
  });

  it("still lands a watched repository with no localPath in other, without crashing", () => {
    const watchedRepos: ReadonlyArray<Repo> = [
      {
        host: "github.com",
        owner: "centraldigital",
        repo: "cfw-bo-customer-management-service",
      },
    ];
    const entries = mergeWatchlistEntries([], watchedRepos);
    const { byRoot, other } = groupWatchlistEntries(entries, [
      "/Users/kwanpham/Work/cfw",
    ]);

    expect(byRoot.get("/Users/kwanpham/Work/cfw")).toEqual([]);
    expect(other).toEqual([
      {
        host: "github.com",
        owner: "centraldigital",
        repo: "cfw-bo-customer-management-service",
        localPath: "",
      },
    ]);
  });
});
