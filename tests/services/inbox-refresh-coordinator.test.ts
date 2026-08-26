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
  scope: "open",
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
