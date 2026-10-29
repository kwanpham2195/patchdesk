import { definedProps } from "./defined-props";
import * as v from "valibot";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  type AbsolutePath,
  type Brand,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type InvalidDomainValue,
} from "./ids";
import { err, ok, type Result } from "./result";

export type LocalRepositoryId = Brand<string, "LocalRepositoryId">;
export type GitHubRepositoryKey = {
  readonly kind: "github";
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
};
export type LocalRepositoryKey = {
  readonly kind: "local";
  readonly localRepositoryId: LocalRepositoryId;
};
export type RepositoryIdentityKey = GitHubRepositoryKey | LocalRepositoryKey;

export type LocalRepositoryRegistration = {
  readonly id: LocalRepositoryId;
  readonly identityKey: RepositoryIdentityKey;
  readonly displayName: string;
} & (
  | {
      readonly state: "resolved";
      readonly configuredRoot: AbsolutePath;
      readonly canonicalCommonDirectory: AbsolutePath;
    }
  | {
      readonly state: "missing";
      readonly configuredRoot: AbsolutePath;
      readonly canonicalCommonDirectory?: AbsolutePath;
    }
  | {
      readonly state: "unresolved";
      readonly configuredRoot?: AbsolutePath;
      readonly canonicalCommonDirectory?: AbsolutePath;
    }
);

export function parseLocalRepositoryId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- UUID parser owns the raw storage and generated-ID boundary.
  input: unknown,
): Result<LocalRepositoryId, InvalidDomainValue> {
  const parsed = v.safeParse(
    v.pipe(
      v.string(),
      v.regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    ),
    input,
  );
  // SAFETY: the UUID syntax above establishes the LocalRepositoryId invariant.
  return parsed.success
    ? ok(parsed.output as LocalRepositoryId)
    : err({ _tag: "InvalidDomainValue", field: "localRepositoryId" });
}

const identityKeySchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("github"),
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
  }),
  v.strictObject({ kind: v.literal("local"), localRepositoryId: v.string() }),
]);

export function parseRepositoryIdentityKey(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persisted identity keys are parsed at this boundary.
  input: unknown,
): Result<RepositoryIdentityKey, InvalidDomainValue> {
  const parsed = v.safeParse(identityKeySchema, input);
  if (!parsed.success)
    return err({ _tag: "InvalidDomainValue", field: "identityKey" });
  const raw = parsed.output;
  if (raw.kind === "local") {
    const id = parseLocalRepositoryId(raw.localRepositoryId);
    return id._tag === "err"
      ? id
      : ok({ kind: "local", localRepositoryId: id.value });
  }
  const host = parseGitHubHost(raw.host),
    owner = parseGitHubOwner(raw.owner),
    repo = parseGitHubRepoName(raw.repo);
  return host._tag === "ok" && owner._tag === "ok" && repo._tag === "ok"
    ? ok({
        kind: "github",
        host: host.value,
        owner: owner.value,
        repo: repo.value,
      })
    : err({ _tag: "InvalidDomainValue", field: "identityKey" });
}

export function sameRepositoryIdentityKey(
  left: RepositoryIdentityKey,
  right: RepositoryIdentityKey,
): boolean {
  return left.kind === "local"
    ? right.kind === "local" &&
        left.localRepositoryId === right.localRepositoryId
    : right.kind === "github" &&
        left.host === right.host &&
        left.owner === right.owner &&
        left.repo === right.repo;
}

const registrationSchema = v.strictObject({
  id: v.string(),
  identityKey: identityKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1)),
  state: v.picklist(["resolved", "missing", "unresolved"]),
  configuredRoot: v.optional(v.string()),
  canonicalCommonDirectory: v.optional(v.string()),
});

export function parseLocalRepositoryRegistration(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- catalog records enter as untrusted JSON at this boundary.
  input: unknown,
): Result<LocalRepositoryRegistration, InvalidDomainValue> {
  const parsed = v.safeParse(registrationSchema, input);
  const invalid = {
    _tag: "InvalidDomainValue",
    field: "localRepositoryRegistration",
  } as const;
  if (!parsed.success) return err(invalid);
  const raw = parsed.output,
    id = parseLocalRepositoryId(raw.id),
    key = parseRepositoryIdentityKey(raw.identityKey);
  const root =
    raw.configuredRoot === undefined
      ? undefined
      : parseAbsolutePath(raw.configuredRoot);
  const common =
    raw.canonicalCommonDirectory === undefined
      ? undefined
      : parseAbsolutePath(raw.canonicalCommonDirectory);
  if (
    id._tag === "err" ||
    key._tag === "err" ||
    root?._tag === "err" ||
    common?._tag === "err" ||
    (key.value.kind === "local" && key.value.localRepositoryId !== id.value)
  )
    return err(invalid);
  const base = {
    id: id.value,
    identityKey: key.value,
    displayName: raw.displayName,
  };
  if (raw.state === "resolved")
    return root === undefined || common === undefined
      ? err(invalid)
      : ok({
          ...base,
          state: raw.state,
          configuredRoot: root.value,
          canonicalCommonDirectory: common.value,
        });
  if (raw.state === "missing" && root === undefined) return err(invalid);
  if (raw.state === "missing" && root !== undefined)
    return ok({
      ...base,
      state: raw.state,
      configuredRoot: root.value,
      ...definedProps({ canonicalCommonDirectory: common?.value }),
    });
  return ok({
    ...base,
    state: "unresolved",
    ...definedProps({ configuredRoot: root?.value }),
    ...definedProps({ canonicalCommonDirectory: common?.value }),
  });
}
