import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { requestJson, selectDirectory } from "../api-client";
import {
  parseGitHubHost,
  parseGitHubLogin,
  parseWorkspaceProfileId,
} from "../../../domain/ids";
import type { ProfileSwitchResult } from "../hooks/use-profile-switch";
import type { Dashboard, Profile } from "../renderer-models";

export type ProfileDraft = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots: ReadonlyArray<ProfileListEntry>;
  readonly rulePaths: ReadonlyArray<ProfileListEntry>;
};

export type ProfileScalarErrors = Readonly<
  Partial<Record<"id" | "label" | "githubHost" | "ghAccount", string>>
>;

type MutableProfileScalarErrors = {
  -readonly [Field in keyof ProfileScalarErrors]?: string;
};

export type ProfileListEntry = {
  readonly id: string;
  readonly value: string;
};

type WorkspaceProfileDraftHook = {
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
  readonly profileError: string | undefined;
  readonly profileScalarErrors: ProfileScalarErrors;
  readonly savingProfile: boolean;
  readonly profileDirty: boolean;
  readonly saveProfile: () => Promise<boolean>;
  readonly selectProfile: (id: string) => void;
  readonly updateProfileList: (
    field: ProfileListField,
    entryId: string,
    value: string,
  ) => void;
  readonly addProfileListEntry: (field: ProfileListField) => void;
  readonly removeProfileListEntry: (
    field: ProfileListField,
    entryId: string,
  ) => void;
  readonly chooseWorkspaceRoot: (entryId: string) => Promise<void>;
};

/**
 * Owns the Workspace section's profile draft: its state, baseline/generation
 * refs, and the save/select/discard handlers. Extracted out of
 * `WorkspaceProfileSection` purely to keep that component's own body short —
 * it isn't reused anywhere else.
 */
export function useWorkspaceProfileDraft({
  dashboard,
  profiles,
  onWorkspaceReload,
  onProfileDirtyChange,
  onProfileSwitchRequest,
  onSaveProfileReady,
  onDiscardProfileReady,
  onProfileSwitch,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly profiles: ReadonlyArray<Profile>;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onProfileDirtyChange: ((dirty: boolean) => void) | undefined;
  readonly onProfileSwitchRequest:
    | ((profileId: string, proceed: () => void) => void)
    | undefined;
  readonly onSaveProfileReady:
    | ((save: () => Promise<boolean>) => void)
    | undefined;
  readonly onDiscardProfileReady: ((discard: () => void) => void) | undefined;
  readonly onProfileSwitch:
    | ((profileId: string) => Promise<ProfileSwitchResult>)
    | undefined;
}): WorkspaceProfileDraftHook {
  const [profileDraft, setProfileDraft] = useState(() =>
    profileDraftFor(dashboard?.profile),
  );
  const [profileError, setProfileError] = useState<string>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [
    profileScalarValidationAttempted,
    setProfileScalarValidationAttempted,
  ] = useState(false);
  const profileBaseline = useRef(profileDraft);
  const pendingSavedProfile = useRef<
    { readonly id: string; readonly label: string } | undefined
  >(undefined);
  const profileDraftGeneration = useRef(0);
  const pendingProfileSave = useRef<Promise<boolean> | undefined>(undefined);
  // A `useCallback` (rather than a plain per-render function) so the
  // reviewing-as adoption effect can list it as a dependency without that
  // dependency being "fresh" on every render.
  const updateProfileDraft = useCallback(
    (update: SetStateAction<ProfileDraft>): void => {
      profileDraftGeneration.current += 1;
      setProfileDraft(update);
      onProfileDirtyChange?.(true);
    },
    [onProfileDirtyChange],
  );
  const profileScalarErrors = profileScalarValidationAttempted
    ? validateProfileScalars(profileDraft)
    : EMPTY_PROFILE_SCALAR_ERRORS;
  const profileDirty =
    JSON.stringify(profileDraft) !== JSON.stringify(profileBaseline.current);

  useEffect(() => {
    if (dashboard === undefined) return;
    const pending = pendingSavedProfile.current;
    if (pending !== undefined) {
      if (
        dashboard.profile.id !== pending.id ||
        dashboard.profile.label !== pending.label
      )
        return;
      pendingSavedProfile.current = undefined;
    }
    if (dashboard.profile.id === profileDraft.id || profileDirty) return;
    const next = profileDraftFor(dashboard.profile);
    profileBaseline.current = next;
    setProfileDraft(next);
  }, [dashboard, profileDirty, profileDraft.id]);

  const saveProfile = (): Promise<boolean> => {
    const pending = pendingProfileSave.current;
    if (pending !== undefined) return pending;

    const save = async (): Promise<boolean> => {
      setProfileError(undefined);
      const scalarErrors = validateProfileScalars(profileDraft);
      if (Object.keys(scalarErrors).length > 0) {
        setProfileScalarValidationAttempted(true);
        return false;
      }
      const normalized = normalizeProfileDraft(profileDraft);
      if (!normalized.ok) {
        setProfileError(normalized.error);
        return false;
      }
      setSavingProfile(true);
      const draftGeneration = profileDraftGeneration.current;
      try {
        await requestJson("/v1/profiles", {
          method: "PUT",
          body: normalized.value,
        });
        const next = profileDraftFromNormalized(normalized.value);
        pendingSavedProfile.current = {
          id: normalized.value.id,
          label: normalized.value.label,
        };
        profileBaseline.current = next;
        if (profileDraftGeneration.current === draftGeneration) {
          setProfileDraft(next);
          setProfileScalarValidationAttempted(false);
          onProfileDirtyChange?.(false);
        } else {
          onProfileDirtyChange?.(true);
        }
        await onWorkspaceReload();
        return true;
      } catch (cause: unknown) {
        setProfileError(
          cause instanceof Error
            ? cause.message
            : "Patchdesk could not save the local review state.",
        );
        return false;
      } finally {
        setSavingProfile(false);
      }
    };

    const savePromise = save();
    pendingProfileSave.current = savePromise;
    void savePromise.finally(() => {
      if (pendingProfileSave.current === savePromise)
        pendingProfileSave.current = undefined;
    });
    return savePromise;
  };

  useEffect(() => {
    onSaveProfileReady?.(saveProfile);
  });

  const discardProfileDraft = (): void => {
    const baseline = profileBaseline.current;
    setProfileDraft(baseline);
    setProfileError(undefined);
    setProfileScalarValidationAttempted(false);
    onProfileDirtyChange?.(false);
  };

  useEffect(() => {
    onDiscardProfileReady?.(discardProfileDraft);
  });

  const performSelectProfile = async (id: string): Promise<void> => {
    const selected = profiles.find((profile) => profile.id === id);
    if (selected === undefined || onProfileSwitch === undefined) return;
    const draftGeneration = profileDraftGeneration.current;
    const next = profileDraftFor(selected);
    setProfileScalarValidationAttempted(false);
    const result = await onProfileSwitch(id);
    if (result !== "applied") return;
    setProfileError(undefined);
    if (profileDraftGeneration.current !== draftGeneration) return;
    profileBaseline.current = next;
    setProfileDraft(next);
    onProfileDirtyChange?.(false);
  };

  const selectProfile = (id: string): void => {
    const proceed = (): void => {
      void performSelectProfile(id);
    };
    if (profileDirty) onProfileSwitchRequest?.(id, proceed);
    else proceed();
  };

  const updateProfileList = (
    field: ProfileListField,
    entryId: string,
    value: string,
  ): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: current[field].map((entry) =>
        entry.id === entryId ? { ...entry, value } : entry,
      ),
    }));
  };

  const addProfileListEntry = (field: ProfileListField): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: [...current[field], profileListEntry("")],
    }));
  };

  const removeProfileListEntry = (
    field: ProfileListField,
    entryId: string,
  ): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: current[field].filter((entry) => entry.id !== entryId),
    }));
  };

  const chooseWorkspaceRoot = async (entryId: string): Promise<void> => {
    const entry = profileDraft.workspaceRoots.find(
      (candidate) => candidate.id === entryId,
    );
    if (entry === undefined) return;
    const selected = await selectDirectory(entry.value);
    if (selected === undefined) return;
    updateProfileList("workspaceRoots", entryId, selected);
  };

  return {
    profileDraft,
    updateProfileDraft,
    profileError,
    profileScalarErrors,
    savingProfile,
    profileDirty,
    saveProfile,
    selectProfile,
    updateProfileList,
    addProfileListEntry,
    removeProfileListEntry,
    chooseWorkspaceRoot,
  };
}

export type ProfileListField = "workspaceRoots" | "rulePaths";

function profileListEntry(value: string): ProfileListEntry {
  return { id: crypto.randomUUID(), value };
}

function profileListEntries(
  values: ReadonlyArray<string>,
): ReadonlyArray<ProfileListEntry> {
  return values.map(profileListEntry);
}

function profileDraftFor(profile: Profile | undefined): ProfileDraft {
  return {
    id: profile?.id ?? "",
    label: profile?.label ?? "",
    githubHost: profile?.githubHost ?? "github.com",
    ghAccount: profile?.ghAccount ?? "",
    workspaceRoots: profileListEntries(
      profile === undefined ? [""] : (profile.workspaceRoots ?? []),
    ),
    rulePaths: profileListEntries(profile?.rulePaths ?? []),
  };
}

const EMPTY_PROFILE_SCALAR_ERRORS: ProfileScalarErrors = {};

type NormalizedProfile = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly rulePaths: ReadonlyArray<string>;
};

/** A domain-level success/failure result, so callers branch on `.ok` instead of a runtime `typeof` check against the success shape. */
type NormalizeProfileResult =
  | { readonly ok: true; readonly value: NormalizedProfile }
  | { readonly ok: false; readonly error: string };

type TrimEntriesResult =
  | { readonly ok: true; readonly values: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: string };

function profileDraftFromNormalized(profile: NormalizedProfile): ProfileDraft {
  return {
    ...profile,
    workspaceRoots: profileListEntries(profile.workspaceRoots),
    rulePaths: profileListEntries(profile.rulePaths),
  };
}

function validateProfileScalars(draft: ProfileDraft) {
  const id = draft.id.trim();
  const label = draft.label.trim();
  const githubHost = draft.githubHost.trim();
  const ghAccount = draft.ghAccount.trim();
  const errors: MutableProfileScalarErrors = {};
  if (parseWorkspaceProfileId(id)._tag !== "ok")
    errors.id =
      "Profile ID must start with a letter or number and then use only letters, numbers, dots, underscores, or hyphens.";
  if (label === "") errors.label = "Label cannot be blank.";
  if (parseGitHubHost(githubHost)._tag !== "ok")
    errors.githubHost =
      "GitHub host must be a hostname without a scheme or path.";
  if (parseGitHubLogin(ghAccount)._tag !== "ok")
    errors.ghAccount =
      "GitHub account must be a valid login of at most 39 characters.";
  return errors;
}

function normalizeProfileDraft(draft: ProfileDraft): NormalizeProfileResult {
  const workspaceRoots = trimEntries(
    draft.workspaceRoots.map((entry) => entry.value),
    "Workspace roots",
  );
  if (!workspaceRoots.ok) return workspaceRoots;
  const rulePaths = trimEntries(
    draft.rulePaths.map((entry) => entry.value),
    "Rule paths",
  );
  if (!rulePaths.ok) return rulePaths;
  return {
    ok: true,
    value: {
      id: draft.id.trim(),
      label: draft.label.trim(),
      githubHost: draft.githubHost.trim(),
      ghAccount: draft.ghAccount.trim(),
      workspaceRoots: workspaceRoots.values,
      rulePaths: rulePaths.values,
    },
  };
}

function trimEntries(
  entries: ReadonlyArray<string>,
  label: string,
): TrimEntriesResult {
  const trimmed = entries.map((entry) => entry.trim());
  return trimmed.some((entry) => entry.length === 0)
    ? { ok: false, error: `${label} cannot contain blank entries.` }
    : { ok: true, values: trimmed };
}
