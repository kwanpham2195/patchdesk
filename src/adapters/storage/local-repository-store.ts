import * as v from "valibot";
import {
  parseContentHash,
  parseWorkspaceProfileId,
  type ContentHash,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  parseLocalRepositoryRegistration,
  sameRepositoryIdentityKey,
  type LocalRepositoryRegistration,
} from "#src/domain/local-repository";
import { err, ok, type Result } from "#src/domain/result";
import {
  readJsonFile,
  writeAtomicJson,
  type StorageFailure,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

export type LocalRepositoryCatalog = {
  readonly format: 1;
  readonly profileId: WorkspaceProfileId;
  readonly generationId: string;
  readonly revision: number;
  readonly repositories: ReadonlyArray<LocalRepositoryRegistration>;
  readonly bootstrapInputFingerprint: ContentHash;
};
const catalogSchema = v.strictObject({
  format: v.literal(1),
  profileId: v.string(),
  generationId: v.pipe(v.string(), v.uuid()),
  revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  repositories: v.array(v.unknown()),
  bootstrapInputFingerprint: v.string(),
});

function parseCatalog(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the catalog store owns decoding untrusted JSON.
  input: unknown,
): Result<LocalRepositoryCatalog, StorageFailure> {
  const invalid = {
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  } as const;
  const parsed = v.safeParse(catalogSchema, input);
  if (!parsed.success) return err(invalid);
  const raw = parsed.output,
    profileId = parseWorkspaceProfileId(raw.profileId),
    fingerprint = parseContentHash(raw.bootstrapInputFingerprint);
  if (profileId._tag === "err" || fingerprint._tag === "err")
    return err(invalid);
  const repositories: LocalRepositoryRegistration[] = [];
  for (const entry of raw.repositories) {
    const registration = parseLocalRepositoryRegistration(entry);
    if (
      registration._tag === "err" ||
      repositories.some(
        (previous) =>
          previous.id === registration.value.id ||
          sameRepositoryIdentityKey(
            previous.identityKey,
            registration.value.identityKey,
          ),
      )
    )
      return err(invalid);
    repositories.push(registration.value);
  }
  for (const repository of repositories) {
    if (repository.canonicalCommonDirectory === undefined) continue;
    if (
      repositories.some(
        (other) =>
          other.id !== repository.id &&
          other.canonicalCommonDirectory ===
            repository.canonicalCommonDirectory &&
          (other.state !== "unresolved" || repository.state !== "unresolved"),
      )
    )
      return err(invalid);
  }
  return ok({
    ...raw,
    profileId: profileId.value,
    bootstrapInputFingerprint: fingerprint.value,
    repositories,
  });
}

/** Atomic profile-scoped catalog persistence; bootstrap never replaces a damaged catalog. */
export class LocalRepositoryStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async load(
    profileId: WorkspaceProfileId,
  ): Promise<Result<LocalRepositoryCatalog, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.localRepositoryCatalogFile(profileId),
    );
    if (stored._tag === "err") return stored;
    const parsed = parseCatalog(stored.value);
    return parsed._tag === "err" || parsed.value.profileId === profileId
      ? parsed
      : err({
          _tag: "StorageFailure",
          operation: "read",
          reason: "invalid_stored_value",
        });
  }

  async save(
    catalog: LocalRepositoryCatalog,
  ): Promise<Result<void, StorageFailure>> {
    const parsed = parseCatalog(catalog);
    return parsed._tag === "err"
      ? err({ ...parsed.error, operation: "write" })
      : writeAtomicJson(
          this.paths.localRepositoryCatalogFile(catalog.profileId),
          parsed.value,
        );
  }
}
