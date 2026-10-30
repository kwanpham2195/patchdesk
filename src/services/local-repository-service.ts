import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";

import type { LocalRepositoryStore } from "#src/adapters/storage/local-repository-store";
import type { ProfileStore } from "#src/adapters/storage/profile-store";
import type { ReviewStore } from "#src/adapters/storage/review-store";
import {
  parseAbsolutePath,
  parseWorkspaceProfileId,
  type AbsolutePath,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  parseLocalRepositoryId,
  sameRepositoryIdentityKey,
  type LocalRepositoryId,
  type LocalRepositoryRegistration,
  type RepositoryIdentityKey,
} from "#src/domain/local-repository";
import { definedProps } from "#src/domain/defined-props";
import { sameRepositoryIdentity } from "#src/domain/repository-identity";
import { mapConcurrent } from "#src/domain/map-concurrent";
import { err, ok, type Result } from "#src/domain/result";
import { isLocalReview } from "#src/domain/review";
import { reviewSourceTitle } from "#src/domain/review-source";
import type { WorkspaceProfileConfig } from "#src/domain/workspace-profile";
import type { AppLogService } from "./app-log-service";
import {
  listRepositoryCheckouts,
  type RepositoryCheckout,
} from "./local-checkout";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { GitReadExecutor } from "./review-worktree-service";
import type { DashboardController } from "./dashboard-controller";

export type LocalRepositoryFailure = {
  readonly reason:
    | "checkout_not_a_repository"
    | "repository_not_local"
    | "checkout_missing"
    | "registration_conflict"
    | "storage";
  readonly localPath?: AbsolutePath;
};
export type RegisteredCheckout = {
  readonly profile: WorkspaceProfileConfig;
  readonly registration: LocalRepositoryRegistration;
  readonly checkout: AbsolutePath;
  readonly profileCreated: boolean;
  readonly repositoryAdded: boolean;
};

export type RelocationFailure = {
  readonly reason:
    | LocalRepositoryFailure["reason"]
    | "repository_not_found"
    | "repository_not_missing"
    | "checkout_registered_elsewhere";
  readonly localPath?: AbsolutePath;
};
/** `relocated` is false for a preview: nothing is saved until the caller confirms. */
export type RelocatedCheckout = {
  readonly registration: LocalRepositoryRegistration;
  readonly checkout: AbsolutePath;
  readonly relocated: boolean;
  /** The Reviews keyed to the registration; relocation keeps all of them. */
  readonly affectedReviews: ReadonlyArray<{
    readonly reviewId: ReviewId;
    /** The stored title, else the one the source names, as the Review header shows. */
    readonly title: string;
  }>;
};

export class LocalRepositoryService {
  private registrationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: {
      readonly profiles: ProfileStore;
      readonly catalog: Pick<LocalRepositoryStore, "load" | "save">;
      readonly dashboard: Pick<
        DashboardController,
        "savedProfiles" | "selectProfile"
      >;
      readonly git: GitReadExecutor;
      readonly paths: Pick<PatchdeskPaths, "cacheDirectory">;
      readonly logs: Pick<AppLogService, "write">;
      readonly reviews: Pick<ReviewStore, "list">;
    },
  ) {}

  async register(
    folder: AbsolutePath,
  ): Promise<Result<RegisteredCheckout, LocalRepositoryFailure>> {
    const scheduled = this.registrationTail.then(() =>
      this.registerCheckout(folder),
    );
    this.registrationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  async setWatchedCheckout(
    profileId: WorkspaceProfileId,
    identityKey: Extract<RepositoryIdentityKey, { kind: "github" }>,
    folder: AbsolutePath,
  ): Promise<Result<WorkspaceProfileConfig, LocalRepositoryFailure>> {
    const scheduled = this.registrationTail.then(async () => {
      const catalog = await this.dependencies.catalog.load(profileId);
      if (catalog._tag === "err") return err({ reason: "storage" as const });
      const profile = await this.dependencies.profiles.load(profileId);
      if (profile._tag === "err") return this.refused(profileId, "storage");
      const watched = profile.value.repos.find((entry) =>
        sameRepositoryIdentity(entry, identityKey),
      );
      if (watched === undefined)
        return this.refused(profileId, "repository_not_local");
      const registration = catalog.value.repositories.find((entry) =>
        sameRepositoryIdentityKey(entry.identityKey, identityKey),
      );
      if (
        watched.localRepositoryId !== undefined &&
        watched.localRepositoryId !== registration?.id
      )
        return this.refused(profileId, "registration_conflict");
      const checkout = await this.discover(folder);
      if (checkout._tag === "err") return checkout;
      if (
        catalog.value.repositories.some(
          (entry) =>
            entry.id !== registration?.id &&
            entry.canonicalCommonDirectory === checkout.value.common,
        )
      )
        return this.refused(profileId, "registration_conflict");
      const id =
        registration === undefined
          ? parseLocalRepositoryId(randomUUID())
          : ok(registration.id);
      if (id._tag === "err") return this.refused(profileId, "storage");
      const updated: LocalRepositoryRegistration = {
        id: id.value,
        identityKey: registration?.identityKey ?? identityKey,
        displayName:
          registration?.displayName ??
          `${identityKey.owner}/${identityKey.repo}`,
        state: "resolved",
        configuredRoot: checkout.value.root,
        canonicalCommonDirectory: checkout.value.common,
      };
      const saved = await this.dependencies.catalog.save({
        ...catalog.value,
        revision: catalog.value.revision + 1,
        repositories:
          registration === undefined
            ? [...catalog.value.repositories, updated]
            : catalog.value.repositories.map((entry) =>
                entry.id === updated.id ? updated : entry,
              ),
      });
      if (saved._tag === "err") return this.refused(profileId, "storage");
      const changed = {
        ...profile.value,
        repos: profile.value.repos.map((entry) =>
          sameRepositoryIdentity(entry, identityKey)
            ? {
                ...entry,
                localPath: checkout.value.root,
                localRepositoryId: updated.id,
              }
            : entry,
        ),
      };
      if ((await this.dependencies.profiles.save(changed))._tag === "err")
        return this.refused(profileId, "storage");
      this.log(profileId, "watched_checkout_set", updated.id);
      return ok(changed);
    });
    this.registrationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  /**
   * Points a missing registration at the checkout in `folder` (ADR 0058,
   * "Relocation and conflicting locators"), keeping its ID and Reviews. Only
   * the locators change. Without `confirm` it validates and reports the
   * affected Reviews and saves nothing.
   */
  async relocate(
    repositoryId: LocalRepositoryId,
    folder: AbsolutePath,
    confirm: boolean,
  ): Promise<Result<RelocatedCheckout, RelocationFailure>> {
    const scheduled = this.registrationTail.then(() =>
      this.relocateRegistration(repositoryId, folder, confirm),
    );
    this.registrationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  private async relocateRegistration(
    repositoryId: LocalRepositoryId,
    folder: AbsolutePath,
    confirm: boolean,
  ): Promise<Result<RelocatedCheckout, RelocationFailure>> {
    const saved = await this.dependencies.dashboard.savedProfiles();
    if (saved._tag === "err")
      return saved.error.reason === "no_profile"
        ? this.refused(undefined, "repository_not_found")
        : err({ reason: "storage" });
    const profile = saved.value.active;
    const catalog = await this.dependencies.catalog.load(profile.id);
    if (catalog._tag === "err") return err({ reason: "storage" });
    const registration = catalog.value.repositories.find(
      (entry) => entry.id === repositoryId,
    );
    if (registration === undefined)
      return this.refused(profile.id, "repository_not_found");
    const [current] = await this.list(profile.id).then((listed) =>
      listed._tag === "ok"
        ? listed.value.filter((entry) => entry.id === repositoryId)
        : [],
    );
    if (current === undefined) return err({ reason: "storage" });
    if (current.state !== "missing")
      return this.refused(profile.id, "repository_not_missing");
    const candidate = await this.discover(folder);
    if (candidate._tag === "err") {
      this.log(profile.id, candidate.error.reason);
      return candidate;
    }
    if (
      catalog.value.repositories.some(
        (entry) =>
          entry.id !== repositoryId &&
          entry.canonicalCommonDirectory === candidate.value.common,
      )
    )
      return this.refused(profile.id, "checkout_registered_elsewhere");
    const listed = await this.dependencies.reviews.list(profile.id);
    if (listed._tag === "err" || listed.value.unreadable > 0)
      return this.refused(profile.id, "storage");
    const affectedReviews = listed.value.reviews.flatMap((review) =>
      isLocalReview(review) &&
      sameRepositoryIdentityKey(
        review.identity.identityKey,
        registration.identityKey,
      )
        ? [
            {
              reviewId: review.id,
              title:
                review.title === undefined || review.title === ""
                  ? reviewSourceTitle(review.identity.source)
                  : review.title,
            },
          ]
        : [],
    );
    const relocated: LocalRepositoryRegistration = {
      id: registration.id,
      identityKey: registration.identityKey,
      displayName: registration.displayName,
      state: "resolved",
      configuredRoot: candidate.value.root,
      canonicalCommonDirectory: candidate.value.common,
    };
    if (!confirm)
      return ok({
        registration: relocated,
        checkout: candidate.value.root,
        relocated: false,
        affectedReviews,
      });
    const published = await this.dependencies.catalog.save({
      ...catalog.value,
      revision: catalog.value.revision + 1,
      repositories: catalog.value.repositories.map((entry) =>
        entry.id === repositoryId ? relocated : entry,
      ),
    });
    if (published._tag === "err") return this.refused(profile.id, "storage");
    if (
      profile.repos.some((entry) => entry.localRepositoryId === repositoryId)
    ) {
      const watched = await this.dependencies.profiles.save({
        ...profile,
        repos: profile.repos.map((entry) =>
          entry.localRepositoryId === repositoryId
            ? { ...entry, localPath: candidate.value.root }
            : entry,
        ),
      });
      // The published catalog is the relocation; a stale watched path does not undo it.
      if (watched._tag === "err")
        this.log(profile.id, "watched_checkout_path_unsaved", repositoryId);
    }
    this.log(profile.id, "checkout_relocated", repositoryId);
    return ok({
      registration: relocated,
      checkout: candidate.value.root,
      relocated: true,
      affectedReviews,
    });
  }

  async list(
    profileId: WorkspaceProfileId,
  ): Promise<
    Result<ReadonlyArray<LocalRepositoryRegistration>, LocalRepositoryFailure>
  > {
    const catalog = await this.dependencies.catalog.load(profileId);
    if (catalog._tag === "err") return err({ reason: "storage" });
    const registrations = await mapConcurrent(
      catalog.value.repositories,
      4,
      async (registration): Promise<LocalRepositoryRegistration> => {
        if (
          registration.configuredRoot === undefined ||
          registration.state === "unresolved"
        ) {
          return registration;
        }
        const current = await this.discover(registration.configuredRoot);
        return current._tag === "ok" &&
          current.value.common === registration.canonicalCommonDirectory
          ? {
              ...registration,
              state: "resolved",
              configuredRoot: current.value.root,
              canonicalCommonDirectory: current.value.common,
            }
          : { ...registration, state: "missing" };
      },
    );
    return ok(registrations);
  }

  async resolve(
    profileId: WorkspaceProfileId,
    folder: AbsolutePath,
  ): Promise<
    Result<
      {
        readonly repository: RepositoryIdentityKey;
        readonly registration: LocalRepositoryRegistration;
        readonly checkout: AbsolutePath;
      } & Pick<RepositoryCheckout, "head" | "configured">,
      LocalRepositoryFailure
    >
  > {
    const discovered = await this.discover(folder);
    if (discovered._tag === "err") {
      this.log(undefined, discovered.error.reason);
      return discovered;
    }
    const registrations = await this.list(profileId);
    if (registrations._tag === "err") return registrations;
    const candidates = registrations.value.filter(
      (entry) => entry.canonicalCommonDirectory === discovered.value.common,
    );
    if (candidates.length > 1)
      return this.refused(profileId, "registration_conflict");
    const registration = candidates[0];
    if (registration === undefined)
      return this.refused(profileId, "repository_not_local");
    if (registration.state !== "resolved")
      return this.refused(
        profileId,
        "checkout_missing",
        registration.configuredRoot,
      );
    const checkouts = await listRepositoryCheckouts(
      this.dependencies,
      registration.configuredRoot,
    );
    const checkout = checkouts?.find(
      (entry) => entry.path === discovered.value.root,
    );
    if (checkout === undefined)
      return this.refused(profileId, "repository_not_local");
    this.log(profileId, "checkout_resolved", registration.id);
    return ok({
      repository: registration.identityKey,
      registration,
      checkout: checkout.path,
      head: checkout.head,
      configured: checkout.configured,
    });
  }

  private async registerCheckout(
    folder: AbsolutePath,
    selectedProfileId?: WorkspaceProfileId,
  ): Promise<Result<RegisteredCheckout, LocalRepositoryFailure>> {
    const discovered = await this.discover(folder);
    if (discovered._tag === "err") {
      this.log(undefined, discovered.error.reason);
      return discovered;
    }
    const saved = await this.dependencies.dashboard.savedProfiles();
    if (saved._tag === "err" && saved.error.reason !== "no_profile")
      return err({ reason: "storage" });
    let profile: WorkspaceProfileConfig;
    const profileCreated = saved._tag === "err";
    if (saved._tag === "ok") {
      const selected =
        selectedProfileId === undefined
          ? saved.value.active
          : saved.value.saved.find(
              (candidate) => candidate.id === selectedProfileId,
            );
      if (selected === undefined) return err({ reason: "storage" });
      profile = selected;
    } else {
      if (selectedProfileId !== undefined) return err({ reason: "storage" });
      const id = parseWorkspaceProfileId("default");
      if (id._tag === "err") return err({ reason: "storage" });
      profile = {
        schemaVersion: 1,
        localRepositoryCatalogGeneration: randomUUID(),
        id: id.value,
        label: "Default",
        github: { kind: "disconnected" },
        repos: [],
        rulePaths: [],
        analysisMergePolicy: "require_acknowledgement",
      };
      if ((await this.dependencies.profiles.save(profile))._tag === "err")
        return err({ reason: "storage" });
      const activated = await this.dependencies.profiles.load(profile.id);
      if (activated._tag === "err") return err({ reason: "storage" });
      profile = activated.value;
    }
    const catalog = await this.dependencies.catalog.load(profile.id);
    if (catalog._tag === "err") return err({ reason: "storage" });
    const candidates = catalog.value.repositories.filter(
      (entry) => entry.canonicalCommonDirectory === discovered.value.common,
    );
    if (candidates.length > 1)
      return this.refused(profile.id, "registration_conflict");
    let registration = candidates[0];
    const repositoryAdded = registration === undefined;
    if (registration !== undefined) {
      if (registration.configuredRoot === undefined)
        return this.refused(profile.id, "registration_conflict");
      const current = await this.discover(registration.configuredRoot);
      if (
        current._tag === "err" ||
        current.value.common !== discovered.value.common
      )
        return this.refused(
          profile.id,
          "checkout_missing",
          registration.configuredRoot,
        );
      if (registration.state === "unresolved")
        return this.refused(profile.id, "registration_conflict");
      if (registration.state === "missing") {
        const restored: LocalRepositoryRegistration = {
          ...registration,
          state: "resolved",
          configuredRoot: current.value.root,
          canonicalCommonDirectory: current.value.common,
        };
        const published = await this.dependencies.catalog.save({
          ...catalog.value,
          revision: catalog.value.revision + 1,
          repositories: catalog.value.repositories.map((entry) =>
            entry.id === restored.id ? restored : entry,
          ),
        });
        if (published._tag === "err")
          return this.refused(profile.id, "storage");
        registration = restored;
      }
    } else {
      const id = parseLocalRepositoryId(randomUUID());
      if (id._tag === "err") return err({ reason: "storage" });
      registration = {
        id: id.value,
        identityKey: { kind: "local", localRepositoryId: id.value },
        displayName: basename(discovered.value.root),
        state: "resolved",
        configuredRoot: discovered.value.root,
        canonicalCommonDirectory: discovered.value.common,
      };
      const published = await this.dependencies.catalog.save({
        ...catalog.value,
        revision: catalog.value.revision + 1,
        repositories: [...catalog.value.repositories, registration],
      });
      if (published._tag === "err") return this.refused(profile.id, "storage");
    }
    if (
      profileCreated &&
      (await this.dependencies.dashboard.selectProfile(profile.id))._tag ===
        "err"
    )
      return err({ reason: "storage" });
    this.log(
      profile.id,
      repositoryAdded ? "checkout_registered" : "registration_reused",
      registration.id,
    );
    return ok({
      profile,
      registration,
      checkout: discovered.value.root,
      profileCreated,
      repositoryAdded,
    });
  }

  private async discover(
    folder: AbsolutePath,
  ): Promise<
    Result<
      { readonly root: AbsolutePath; readonly common: AbsolutePath },
      LocalRepositoryFailure
    >
  > {
    const [root, common] = await Promise.all([
      this.dependencies.git.run([
        "git",
        "-C",
        folder,
        "rev-parse",
        "--show-toplevel",
      ]),
      this.dependencies.git.run([
        "git",
        "-C",
        folder,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    ]);
    if (root._tag === "err" || common._tag === "err")
      return err({ reason: "checkout_not_a_repository" });
    const canonical = await Promise.all(
      [root.value.stdout.trim(), common.value.stdout.trim()].map((path) =>
        realpath(path).catch(() => undefined),
      ),
    );
    const parsedRoot = parseAbsolutePath(canonical[0]),
      parsedCommon = parseAbsolutePath(canonical[1]);
    if (parsedRoot._tag === "err" || parsedCommon._tag === "err")
      return err({ reason: "checkout_not_a_repository" });
    const checkouts = await listRepositoryCheckouts(
      this.dependencies,
      parsedRoot.value,
    );
    if (!checkouts?.some((entry) => entry.path === parsedRoot.value))
      return err({ reason: "checkout_not_a_repository" });
    return ok({ root: parsedRoot.value, common: parsedCommon.value });
  }

  private refused<Reason extends RelocationFailure["reason"]>(
    profileId: WorkspaceProfileId | undefined,
    reason: Reason,
    localPath?: AbsolutePath,
  ): Result<
    never,
    { readonly reason: Reason; readonly localPath?: AbsolutePath }
  > {
    this.log(profileId, reason);
    return err({ reason, ...definedProps({ localPath }) });
  }

  private log(
    profileId: WorkspaceProfileId | undefined,
    reason:
      | RelocationFailure["reason"]
      | "checkout_relocated"
      | "watched_checkout_path_unsaved"
      | "watched_checkout_set"
      | "checkout_resolved"
      | "checkout_registered"
      | "registration_reused",
    repositoryId?: string,
  ): void {
    this.dependencies.logs.write({
      process: "main",
      level: "info",
      topic: "local-repository",
      message: "Local repository transition",
      ...definedProps({ profileId }),
      meta: { reason, ...definedProps({ repositoryId }) },
    });
  }
}
