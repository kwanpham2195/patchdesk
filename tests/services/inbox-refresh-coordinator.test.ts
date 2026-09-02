import { describe, expect, it, vi } from "vitest";

import { InboxRefreshCoordinator } from "../../src/services/inbox-refresh-coordinator";
import type {
  InboxRepositoryRef,
  MaintainerInbox,
} from "../../src/services/maintainer-inbox-service";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ok } from "../../src/domain/result";

// SAFETY: InboxRefreshCoordinator reads only the profile id to separate
// in-flight requests; these fixtures provide that sole dependency.
const profile = { id: "cfw" } as WorkspaceProfileConfig;
// SAFETY: InboxRefreshCoordinator reads only the profile id to separate
// in-flight requests; these fixtures provide that sole dependency.
const secondProfile = { id: "other" } as WorkspaceProfileConfig;
// SAFETY: InboxRefreshCoordinator and the fake `list` reads read only these
// three fields; the plain strings stand in for the branded GitHub identity
// types this fixture never needs to parse.
const repository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "patchdesk",
} as InboxRepositoryRef;
// SAFETY: same rationale as `repository` above — a second, distinct watched
// repository under the same profile.
const secondRepository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "other-repo",
} as InboxRepositoryRef;
const inbox = {
  state: "open",
  pageSize: 25,
  rows: [],
  repositories: [],
  dataFreshness: "fresh",
  snapshot: { state: "current" },
} satisfies MaintainerInbox;

describe("inbox refresh coordinator", () => {
  it("shares one read-only inbox scan for concurrent callers in the same profile and repository", async () => {
    let resolveScan:
      | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
      | undefined;
    const scan = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
      (resolve) => {
        resolveScan = resolve;
      },
    );
    const list = vi.fn(() => scan);
    const coordinator = new InboxRefreshCoordinator({ list });

    const automatic = coordinator.refresh(profile, repository);
    const manual = coordinator.refresh(profile, repository);

    expect(list).toHaveBeenCalledTimes(1);
    expect(automatic).toBe(manual);
    resolveScan?.(ok(inbox));
    await expect(manual).resolves.toEqual(ok(inbox));

    await coordinator.refresh(profile, repository);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps scans isolated per profile", async () => {
    const list = vi.fn(async () => ok(inbox));
    const coordinator = new InboxRefreshCoordinator({ list });

    await Promise.all([
      coordinator.refresh(profile, repository),
      coordinator.refresh(secondProfile, repository),
    ]);

    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps scans isolated per repository within the same profile, while still coalescing the same repository", async () => {
    // A repository-A read that never resolves on its own — every assertion
    // below has to happen while it is still genuinely in flight, or a
    // coordinator key that ignores the repository would pass anyway.
    let resolveA:
      | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
      | undefined;
    const pendingA = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
      (resolve) => {
        resolveA = resolve;
      },
    );
    const list = vi.fn(
      (_profile: WorkspaceProfileConfig, repo: InboxRepositoryRef) =>
        repo.repo === repository.repo ? pendingA : Promise.resolve(ok(inbox)),
    );
    const coordinator = new InboxRefreshCoordinator({ list });

    // Start repository A; it stays pending until resolveA runs below.
    const firstA = coordinator.refresh(profile, repository);
    // A second concurrent call for the SAME repository, while A is still
    // in flight, must coalesce onto it rather than issue a second read.
    const secondA = coordinator.refresh(profile, repository);
    expect(list).toHaveBeenCalledTimes(1);

    // While A is still in flight (not resolved, not even awaited yet), a
    // call for a DIFFERENT repository under the same profile must not
    // coalesce onto A's pending promise. With a key that ignores the
    // repository, this call would find A's entry still in `inFlight` and
    // the count below would stay at 1.
    const firstB = coordinator.refresh(profile, secondRepository);
    expect(list).toHaveBeenCalledTimes(2);

    resolveA?.(ok(inbox));
    await expect(Promise.all([firstA, secondA, firstB])).resolves.toEqual([
      ok(inbox),
      ok(inbox),
      ok(inbox),
    ]);
  });
});

it("does not coalesce different page tokens for the same profile and repository", async () => {
  let resolveFirst:
    | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
    | undefined;
  const first = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
    (resolve) => {
      resolveFirst = resolve;
    },
  );
  const list = vi.fn(
    (
      _profile: WorkspaceProfileConfig,
      _repository: InboxRepositoryRef,
      page?: { readonly pageToken?: string },
    ) => (page?.pageToken === undefined ? first : Promise.resolve(ok(inbox))),
  );
  const coordinator = new InboxRefreshCoordinator({ list });

  const firstPage = coordinator.refresh(profile, repository, {
    filter: { state: "open" },
    pageSize: 25,
  });
  const nextPage = coordinator.refresh(profile, repository, {
    filter: { state: "open" },
    pageSize: 25,
    pageToken: "opaque-next-page",
  });

  expect(list).toHaveBeenCalledTimes(2);
  resolveFirst?.(ok(inbox));
  await expect(Promise.all([firstPage, nextPage])).resolves.toEqual([
    ok(inbox),
    ok(inbox),
  ]);
});

it("does not coalesce different page sizes for the same profile and repository", async () => {
  let resolveDefault:
    | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
    | undefined;
  const defaultSize = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
    (resolve) => {
      resolveDefault = resolve;
    },
  );
  const list = vi.fn(
    (
      _profile: WorkspaceProfileConfig,
      _repository: InboxRepositoryRef,
      page?: { readonly pageSize?: number },
    ) => (page?.pageSize === 25 ? defaultSize : Promise.resolve(ok(inbox))),
  );
  const coordinator = new InboxRefreshCoordinator({ list });

  const defaultPage = coordinator.refresh(profile, repository, {
    filter: { state: "open" },
    pageSize: 25,
  });
  const largerPage = coordinator.refresh(profile, repository, {
    filter: { state: "open" },
    pageSize: 50,
  });

  expect(list).toHaveBeenCalledTimes(2);
  resolveDefault?.(ok(inbox));
  await expect(Promise.all([defaultPage, largerPage])).resolves.toEqual([
    ok(inbox),
    ok(inbox),
  ]);
});

it("does not coalesce different filters for the same profile and repository", async () => {
  let resolveOpen:
    | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
    | undefined;
  const openScan = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
    (resolve) => {
      resolveOpen = resolve;
    },
  );
  const list = vi.fn(
    (
      _profile: WorkspaceProfileConfig,
      _repository: InboxRepositoryRef,
      page?: { readonly filter?: { readonly state?: string } },
    ) =>
      page?.filter?.state === "open" ? openScan : Promise.resolve(ok(inbox)),
  );
  const coordinator = new InboxRefreshCoordinator({ list });

  const openPage = coordinator.refresh(profile, repository, {
    filter: { state: "open" },
    pageSize: 25,
  });
  const mergedPage = coordinator.refresh(profile, repository, {
    filter: { state: "merged" },
    pageSize: 25,
  });

  expect(list).toHaveBeenCalledTimes(2);
  resolveOpen?.(ok(inbox));
  await expect(Promise.all([openPage, mergedPage])).resolves.toEqual([
    ok(inbox),
    ok(inbox),
  ]);
});

it("does not coalesce different label filters for the same profile and repository", async () => {
  // The unfiltered read never resolves on its own, so the assertions below
  // all happen while it is genuinely in flight — a key that ignores
  // `filter.labels` would find its entry and serve its rows to the second
  // caller.
  let resolveUnfiltered:
    | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
    | undefined;
  const unfiltered = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
    (resolve) => {
      resolveUnfiltered = resolve;
    },
  );
  const list = vi.fn(
    (
      _profile: WorkspaceProfileConfig,
      _repository: InboxRepositoryRef,
      page?: { readonly filter?: { readonly labels?: ReadonlyArray<string> } },
    ) =>
      (page?.filter?.labels ?? []).length === 0
        ? unfiltered
        : Promise.resolve(ok(inbox)),
  );
  const coordinator = new InboxRefreshCoordinator({ list });

  const everything = coordinator.refresh(profile, repository, {
    filter: { state: "open" },
    pageSize: 25,
  });
  const bugsOnly = coordinator.refresh(profile, repository, {
    filter: { state: "open", labels: ["bug"] },
    pageSize: 25,
  });

  expect(list).toHaveBeenCalledTimes(2);
  resolveUnfiltered?.(ok(inbox));
  await expect(Promise.all([everything, bugsOnly])).resolves.toEqual([
    ok(inbox),
    ok(inbox),
  ]);
});

it("does not coalesce different review or check filters for the same repository", async () => {
  let resolveScan:
    | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
    | undefined;
  const scan = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
    (resolve) => {
      resolveScan = resolve;
    },
  );
  const list = vi.fn(() => scan);
  const coordinator = new InboxRefreshCoordinator({ list });

  const approved = coordinator.refresh(profile, repository, {
    filter: { state: "open", reviewState: "approved" },
    pageSize: 25,
  });
  const failingChecks = coordinator.refresh(profile, repository, {
    filter: { state: "open", checkStatus: "failure" },
    pageSize: 25,
  });

  expect(list).toHaveBeenCalledTimes(2);
  resolveScan?.(ok(inbox));
  await expect(Promise.all([approved, failingChecks])).resolves.toEqual([
    ok(inbox),
    ok(inbox),
  ]);
});

it("does not coalesce different author or base branch filters for the same repository", async () => {
  let resolveScan:
    | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
    | undefined;
  const scan = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
    (resolve) => {
      resolveScan = resolve;
    },
  );
  const list = vi.fn(() => scan);
  const coordinator = new InboxRefreshCoordinator({ list });

  const byOctocat = coordinator.refresh(profile, repository, {
    filter: { state: "open", author: "octocat" },
    pageSize: 25,
  });
  const byHubber = coordinator.refresh(profile, repository, {
    filter: { state: "open", author: "hubber" },
    pageSize: 25,
  });
  const ontoRelease = coordinator.refresh(profile, repository, {
    filter: { state: "open", baseBranch: "release/1.0" },
    pageSize: 25,
  });

  expect(list).toHaveBeenCalledTimes(3);
  resolveScan?.(ok(inbox));
  await expect(
    Promise.all([byOctocat, byHubber, ontoRelease]),
  ).resolves.toEqual([ok(inbox), ok(inbox), ok(inbox)]);
});

it("coalesces label filters that differ only by order or repetition", async () => {
  let resolveScan:
    | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
    | undefined;
  const scan = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
    (resolve) => {
      resolveScan = resolve;
    },
  );
  const list = vi.fn(() => scan);
  const coordinator = new InboxRefreshCoordinator({ list });

  // `["b","a"]`, `["a","b"]`, and `["a","b","a"]` all compose into the same
  // GitHub search query, so they are one read, not three.
  const first = coordinator.refresh(profile, repository, {
    filter: { state: "open", labels: ["b", "a"] },
    pageSize: 25,
  });
  const second = coordinator.refresh(profile, repository, {
    filter: { state: "open", labels: ["a", "b"] },
    pageSize: 25,
  });
  const third = coordinator.refresh(profile, repository, {
    filter: { state: "open", labels: ["a", "b", "a"] },
    pageSize: 25,
  });

  expect(list).toHaveBeenCalledTimes(1);
  expect(second).toBe(first);
  expect(third).toBe(first);
  resolveScan?.(ok(inbox));
  await expect(Promise.all([first, second, third])).resolves.toEqual([
    ok(inbox),
    ok(inbox),
    ok(inbox),
  ]);
});
