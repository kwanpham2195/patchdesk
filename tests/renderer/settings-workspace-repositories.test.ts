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
  it("keeps a sibling-prefix repository outside the workspace root", () => {
    const entries = mergeWatchlistEntries(
      [],
      [
        {
          host: "github.com",
          owner: "owner",
          repo: "app-two",
          localPath: "/workspace/app-two/repo",
        },
      ],
    );

    const { byRoot, other } = groupWatchlistEntries(entries, [
      "/workspace/app",
    ]);

    expect(byRoot.get("/workspace/app")).toEqual([]);
    expect(other).toEqual(entries);
  });

  it.each([
    ["an exact root", "/workspace/app", "/workspace/app"],
    ["a descendant", "/workspace/app", "/workspace/app/repo"],
    [
      "a root with trailing separators",
      "/workspace/app//",
      "/workspace/app/repo",
    ],
    ["the filesystem root", "/", "/workspace/app/repo"],
  ])("groups %s", (_name, root, localPath) => {
    const entries = mergeWatchlistEntries(
      [],
      [{ host: "github.com", owner: "owner", repo: "repo", localPath }],
    );

    const { byRoot, other } = groupWatchlistEntries(entries, [root]);

    expect(byRoot.get(root)).toEqual(entries);
    expect(other).toEqual([]);
  });

  it("preserves group order and entries with no local path", () => {
    const entries = mergeWatchlistEntries(
      [],
      [
        {
          host: "github.com",
          owner: "owner",
          repo: "first",
          localPath: "/workspace/app/first",
        },
        { host: "github.com", owner: "owner", repo: "unknown" },
        {
          host: "github.com",
          owner: "owner",
          repo: "second",
          localPath: "/workspace/app/second",
        },
      ],
    );

    const { byRoot, other } = groupWatchlistEntries(entries, [
      "/workspace/app",
    ]);

    expect(byRoot.get("/workspace/app")).toEqual([entries[0], entries[2]]);
    expect(other).toEqual([entries[1]]);
  });

  it("keeps entries under the first duplicate root", () => {
    const entries = mergeWatchlistEntries(
      [],
      [
        {
          host: "github.com",
          owner: "owner",
          repo: "repo",
          localPath: "/workspace/app/repo",
        },
      ],
    );

    const { byRoot, other } = groupWatchlistEntries(entries, [
      "/workspace/app",
      "/workspace/app",
    ]);

    expect(byRoot.get("/workspace/app")).toEqual(entries);
    expect(other).toEqual([]);
  });

  it("assigns nested-root entries to the first root only", () => {
    const entries = mergeWatchlistEntries(
      [],
      [
        {
          host: "github.com",
          owner: "owner",
          repo: "repo",
          localPath: "/workspace/app/nested/repo",
        },
      ],
    );

    const { byRoot, other } = groupWatchlistEntries(entries, [
      "/workspace/app",
      "/workspace/app/nested",
    ]);

    expect(byRoot.get("/workspace/app")).toEqual(entries);
    expect(byRoot.get("/workspace/app/nested")).toEqual([]);
    expect(other).toEqual([]);
  });
});
