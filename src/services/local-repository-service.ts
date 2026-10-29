import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";

import type { LocalRepositoryStore } from "#src/adapters/storage/local-repository-store";
import type { ProfileStore } from "#src/adapters/storage/profile-store";
import {
  parseAbsolutePath,
  parseWorkspaceProfileId,
  type AbsolutePath,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  parseLocalRepositoryId,
  sameRepositoryIdentityKey,
  type LocalRepositoryRegistration,
  type RepositoryIdentityKey,
} from "#src/domain/local-repository";
import { definedProps } from "#src/domain/defined-props";
import { mapConcurrent } from "#src/domain/map-concurrent";
import { err, ok, type Result } from "#src/domain/result";
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
  ): Promise<Result<void, LocalRepositoryFailure>> {
    const scheduled = this.registrationTail.then(async () => {
      const catalog = await this.dependencies.catalog.load(profileId);
      if (catalog._tag === "err") return err({ reason: "storage" as const });
      const registration = catalog.value.repositories.find((entry) =>
        sameRepositoryIdentityKey(entry.identityKey, identityKey),
      );
      if (registration === undefined) {
        const registered = await this.registerCheckout(folder, profileId);
        return registered._tag === "err" ? registered : ok(undefined);
      }
      const checkout = await this.discover(folder);
      if (checkout._tag === "err") return checkout;
      if (
        catalog.value.repositories.some(
          (entry) =>
            entry.id !== registration.id &&
            entry.canonicalCommonDirectory === checkout.value.common,
        )
      )
        return this.refused(profileId, "registration_conflict");
      const saved = await this.dependencies.catalog.save({
        ...catalog.value,
        revision: catalog.value.revision + 1,
        repositories: catalog.value.repositories.map((entry) =>
          entry.id !== registration.id
            ? entry
            : {
                ...entry,
                state: "resolved",
                configuredRoot: checkout.value.root,
                canonicalCommonDirectory: checkout.value.common,
              },
        ),
      });
      if (saved._tag === "err") return this.refused(profileId, "storage");
      this.log(profileId, "watched_checkout_set", registration.id);
      return ok(undefined);
    });
    this.registrationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
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

  private refused(
    profileId: WorkspaceProfileId,
    reason: LocalRepositoryFailure["reason"],
    localPath?: AbsolutePath,
  ): Result<never, LocalRepositoryFailure> {
    this.log(profileId, reason);
    return err({ reason, ...definedProps({ localPath }) });
  }

  private log(
    profileId: WorkspaceProfileId | undefined,
    reason:
      | LocalRepositoryFailure["reason"]
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
