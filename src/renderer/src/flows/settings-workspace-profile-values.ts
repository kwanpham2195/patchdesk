import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubLogin,
} from "../../../domain/ids";
import type { Profile } from "../renderer-models";

/** The profile fields every `PUT /v1/profiles` from the Workspace editor carries. */
export type ProfileValues = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly rulePaths: ReadonlyArray<string>;
};

export type ProfileListField = "workspaceRoots" | "rulePaths";
export type ProfileScalarField = "label" | "githubHost" | "ghAccount";
export type ProfileEditorField = ProfileScalarField | ProfileListField;

/** One editable list row. The id is local, so typing into a row never re-keys it. */
export type ProfileListEntry = {
  readonly id: string;
  readonly value: string;
};

export type ProfileRows = {
  readonly workspaceRoots: ReadonlyArray<ProfileListEntry>;
  readonly rulePaths: ReadonlyArray<ProfileListEntry>;
};

/** The three single-value profile fields, as the editor holds them locally. */
export type ProfileScalars = {
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
};

/** The fields one patch changes: a profile with every field optional. */
export type ProfilePatch = {
  -readonly [Field in keyof ProfileValues]?: ProfileValues[Field];
};

const LIST_FIELDS: ReadonlyArray<ProfileListField> = [
  "workspaceRoots",
  "rulePaths",
];

const EMPTY_VALUES: ReadonlyArray<string> = [];

export function profileListEntry(value: string): ProfileListEntry {
  return { id: crypto.randomUUID(), value };
}

export function profileValuesFor(profile: Profile | undefined): ProfileValues {
  return {
    id: profile?.id ?? "",
    label: profile?.label ?? "",
    githubHost: profile?.githubHost ?? "github.com",
    ghAccount: profile?.ghAccount ?? "",
    workspaceRoots: profile?.workspaceRoots ?? EMPTY_VALUES,
    rulePaths: profile?.rulePaths ?? EMPTY_VALUES,
  };
}

export function scalarsFor(values: ProfileValues): ProfileScalars {
  return {
    label: values.label,
    githubHost: values.githubHost,
    ghAccount: values.ghAccount,
  };
}

export function rowsFor(values: ProfileValues): ProfileRows {
  const roots = values.workspaceRoots.map(profileListEntry);
  return {
    // A workspace with no folder still needs the row that carries "Choose
    // folder" — otherwise its only affordance is "Add folder", and the
    // first-root prompt this blank row exists for could never render.
    workspaceRoots: roots.length === 0 ? [profileListEntry("")] : roots,
    rulePaths: values.rulePaths.map(profileListEntry),
  };
}

/** The scalar half of a patch, so a save applies only the fields it sent. */
export function scalarPatch(fields: ProfilePatch): ProfilePatch {
  const patched: ProfilePatch = {};
  if (fields.label !== undefined) patched.label = fields.label;
  if (fields.githubHost !== undefined) patched.githubHost = fields.githubHost;
  if (fields.ghAccount !== undefined) patched.ghAccount = fields.ghAccount;
  return patched;
}

/** The persisted values for exactly the keys a failed patch had tried to change. */
export function persistedForFields(
  values: ProfileValues,
  fields: ProfilePatch,
): ProfilePatch {
  const restored: ProfilePatch = {};
  if ("label" in fields) restored.label = values.label;
  if ("githubHost" in fields) restored.githubHost = values.githubHost;
  if ("ghAccount" in fields) restored.ghAccount = values.ghAccount;
  if ("workspaceRoots" in fields)
    restored.workspaceRoots = values.workspaceRoots;
  if ("rulePaths" in fields) restored.rulePaths = values.rulePaths;
  return restored;
}

/**
 * Rewrites the rows of each list the server just confirmed, keeping the row
 * ids and any blank row the user is still typing into — a blank row is never
 * sent, so it has no counterpart among the persisted values to match against.
 */
export function reconcileRows(
  current: ProfileRows,
  body: ProfileValues,
  fields: ProfilePatch,
): ProfileRows {
  let next = current;
  for (const field of LIST_FIELDS) {
    if (fields[field] === undefined) continue;
    next = { ...next, [field]: reconcileList(next[field], body[field]) };
  }
  return next;
}

function reconcileList(
  rows: ReadonlyArray<ProfileListEntry>,
  values: ReadonlyArray<string>,
): ReadonlyArray<ProfileListEntry> {
  const next: ProfileListEntry[] = [];
  let index = 0;
  for (const row of rows) {
    if (row.value.trim() === "") {
      next.push(row);
      continue;
    }
    const value = values[index];
    index += 1;
    next.push(value === undefined ? row : { ...row, value });
  }
  for (; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined) next.push(profileListEntry(value));
  }
  return next;
}

/** The request body: the whole profile, with the lists as plain JSON arrays. */
export function profileRequestBody(values: ProfileValues) {
  return {
    id: values.id,
    label: values.label,
    githubHost: values.githubHost,
    ghAccount: values.ghAccount,
    workspaceRoots: [...values.workspaceRoots],
    rulePaths: [...values.rulePaths],
  };
}

/** The client-side reason one scalar cannot be sent, or undefined when it can. */
export function scalarError(
  field: ProfileScalarField,
  value: string,
): string | undefined {
  if (field === "label")
    return value === "" ? "Label cannot be blank." : undefined;
  if (field === "githubHost")
    return parseGitHubHost(value)._tag === "ok"
      ? undefined
      : "GitHub host must be a hostname without a scheme or path.";
  return parseGitHubLogin(value)._tag === "ok"
    ? undefined
    : "GitHub account must be a valid login of at most 39 characters.";
}

/** The client-side reason one list cannot be sent, or undefined when it can. */
export function listError(
  field: ProfileListField,
  values: ReadonlyArray<string>,
): string | undefined {
  const invalid = values.some(
    (value) => parseAbsolutePath(value)._tag !== "ok",
  );
  if (!invalid) return undefined;
  const label = field === "workspaceRoots" ? "Workspace roots" : "Rule paths";
  return `${label} must be absolute paths starting with "/".`;
}

export function sameValueList(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function sameProfileValues(
  left: ProfileValues,
  right: ProfileValues,
): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.githubHost === right.githubHost &&
    left.ghAccount === right.ghAccount &&
    sameValueList(left.workspaceRoots, right.workspaceRoots) &&
    sameValueList(left.rulePaths, right.rulePaths)
  );
}
