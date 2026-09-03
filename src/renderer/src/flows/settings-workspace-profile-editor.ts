import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson, selectDirectory } from "../api-client";
import type { ProfileSwitchResult } from "../hooks/use-profile-switch";
import type { Dashboard, Profile } from "../renderer-models";
import {
  listError,
  persistedForFields,
  profileListEntry,
  profileRequestBody,
  profileValuesFor,
  reconcileRows,
  rowsFor,
  sameProfileValues,
  sameValueList,
  scalarError,
  scalarPatch,
  scalarsFor,
  type ProfileEditorField,
  type ProfileListEntry,
  type ProfileListField,
  type ProfilePatch,
  type ProfileRows,
  type ProfileScalarField,
  type ProfileScalars,
  type ProfileValues,
} from "./settings-workspace-profile-values";

/** Every Workspace control's status, keyed by the field it belongs to. */
type ProfileFieldStatuses = {
  readonly label: FieldStatus;
  readonly githubHost: FieldStatus;
  readonly ghAccount: FieldStatus;
  readonly workspaceRoots: FieldStatus;
  readonly rulePaths: FieldStatus;
};

/** What one control reports beside itself about its own last save. */
export type FieldStatus =
  | { readonly state: "idle" }
  | { readonly state: "saving" }
  | { readonly state: "saved" }
  | { readonly state: "failed"; readonly message: string };

type WorkspaceProfileEditorHook = {
  readonly persisted: ProfileValues;
  readonly scalars: ProfileScalars;
  readonly rows: ProfileRows;
  readonly status: ProfileFieldStatuses;
  readonly editScalar: (field: ProfileScalarField, value: string) => void;
  readonly commitScalar: (field: ProfileScalarField) => void;
  readonly selectAccount: (login: string, host: string) => void;
  readonly editListEntry: (
    field: ProfileListField,
    entryId: string,
    value: string,
  ) => void;
  readonly commitList: (field: ProfileListField) => void;
  readonly addListEntry: (field: ProfileListField) => void;
  readonly removeListEntry: (field: ProfileListField, entryId: string) => void;
  readonly chooseWorkspaceRoot: (entryId: string) => Promise<void>;
  readonly selectProfile: (id: string) => void;
};

/** How long a control keeps saying "Saved" before going quiet again. */
const SAVED_STATUS_MS = 2_000;

/**
 * Owns Settings > Workspace's one persistence model: every control saves on
 * its own through `patch`, which merges the change into the last body sent
 * and PUTs the whole profile. Local state exists only so a user can type
 * before committing — the truth is `persisted`, the last profile the server
 * confirmed.
 */
export function useWorkspaceProfileEditor({
  dashboard,
  profiles,
  onWorkspaceReload,
  onProfileSwitch,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly profiles: ReadonlyArray<Profile>;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onProfileSwitch:
    | ((profileId: string) => Promise<ProfileSwitchResult>)
    | undefined;
}): WorkspaceProfileEditorHook {
  const [persisted, setPersisted] = useState(() =>
    profileValuesFor(dashboard?.profile),
  );
  const [scalars, setScalars] = useState(() => scalarsFor(persisted));
  const [rows, setRows] = useState<ProfileRows>(() => rowsFor(persisted));
  const [status, setStatus] = useState(IDLE_STATUS);
  const persistedRef = useRef(persisted);
  // The last body sent, so two in-flight patches compose instead of the
  // second one clobbering the first one's field with a pre-edit value.
  const requested = useRef(persisted);
  const generation = useRef(0);
  const pending = useRef(0);
  const savedTimers = useRef(new Map<ProfileEditorField, number>());

  useEffect(() => {
    const timers = savedTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const putStatus = useCallback(
    (field: ProfileEditorField, next: FieldStatus): void => {
      const timer = savedTimers.current.get(field);
      if (timer !== undefined) {
        clearTimeout(timer);
        savedTimers.current.delete(field);
      }
      setStatus((current) => ({ ...current, [field]: next }));
      if (next.state !== "saved") return;
      savedTimers.current.set(
        field,
        // `window.setTimeout` for the DOM's numeric handle: this only ever
        // runs in the renderer, and `savedTimers` is keyed by field.
        window.setTimeout(() => {
          savedTimers.current.delete(field);
          setStatus((current) =>
            current[field].state === "saved"
              ? { ...current, [field]: IDLE }
              : current,
          );
        }, SAVED_STATUS_MS),
      );
    },
    [],
  );

  // Adopts one server-confirmed profile as the truth: the local values and
  // the per-field statuses belong to the profile they were typed against, so
  // they are replaced together rather than left describing a profile that is
  // no longer loaded.
  const adopt = useCallback((next: ProfileValues): void => {
    persistedRef.current = next;
    requested.current = next;
    setPersisted(next);
    setScalars(scalarsFor(next));
    setRows(rowsFor(next));
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- the server's profile is the truth here, not a value copied out of a prop: when it changes under this editor (a profile switch, a write from another surface) the editor must adopt it, statuses included.
    setStatus(IDLE_STATUS);
  }, []);

  // Resyncs from the server's profile — a switch, another surface's write, or
  // the reload after this editor's own save. Skipped while a patch is in
  // flight, since that patch applies its own, newer result when it lands.
  useEffect(() => {
    if (dashboard === undefined) return;
    if (pending.current > 0) return;
    const next = profileValuesFor(dashboard.profile);
    if (sameProfileValues(next, persistedRef.current)) return;
    adopt(next);
  }, [dashboard, adopt]);

  const patch = useCallback(
    async (fields: ProfilePatch, field: ProfileEditorField): Promise<void> => {
      const body: ProfileValues = { ...requested.current, ...fields };
      requested.current = body;
      const sent = ++generation.current;
      pending.current += 1;
      putStatus(field, SAVING);
      try {
        await requestJson("/v1/profiles", {
          method: "PUT",
          body: profileRequestBody(body),
        });
        // Only the latest request may claim the persisted value; an older
        // response landing late would otherwise undo a newer edit.
        if (generation.current === sent) {
          persistedRef.current = body;
          setPersisted(body);
          setScalars((current) => ({ ...current, ...scalarPatch(fields) }));
          setRows((current) => reconcileRows(current, body, fields));
        }
        putStatus(field, SAVED);
        await onWorkspaceReload();
      } catch (cause: unknown) {
        requested.current = {
          ...requested.current,
          ...persistedForFields(persistedRef.current, fields),
        };
        putStatus(field, {
          state: "failed",
          message:
            cause instanceof Error
              ? cause.message
              : "Patchdesk could not save the local review state.",
        });
      } finally {
        pending.current -= 1;
      }
    },
    [onWorkspaceReload, putStatus],
  );

  const editScalar = useCallback(
    (field: ProfileScalarField, value: string): void => {
      setScalars((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  // Restoring the persisted value is a fix, so the field stops reporting the
  // rejection it is no longer carrying.
  const clearFailure = (field: ProfileEditorField): void => {
    if (status[field].state === "failed") putStatus(field, IDLE);
  };

  const commitScalar = (field: ProfileScalarField): void => {
    const value = scalars[field].trim();
    if (value === persisted[field]) {
      editScalar(field, value);
      clearFailure(field);
      return;
    }
    const invalid = scalarError(field, value);
    if (invalid !== undefined) {
      putStatus(field, { state: "failed", message: invalid });
      return;
    }
    void patch({ [field]: value }, field);
  };

  const selectAccount = (login: string, host: string): void => {
    setScalars((current) => ({
      ...current,
      ghAccount: login,
      githubHost: host,
    }));
    if (login === persisted.ghAccount && host === persisted.githubHost) return;
    void patch({ ghAccount: login, githubHost: host }, "ghAccount");
  };

  const commitRows = (
    field: ProfileListField,
    entries: ReadonlyArray<ProfileListEntry>,
  ): void => {
    // Blank rows are local only: a persisted list never carries one.
    const values = entries.flatMap((entry) => {
      const value = entry.value.trim();
      return value === "" ? [] : [value];
    });
    const invalid = listError(field, values);
    if (invalid !== undefined) {
      putStatus(field, { state: "failed", message: invalid });
      return;
    }
    if (sameValueList(values, persisted[field])) {
      clearFailure(field);
      return;
    }
    void patch({ [field]: values }, field);
  };

  const removeListEntry = (field: ProfileListField, entryId: string): void => {
    const next = rows[field].filter((entry) => entry.id !== entryId);
    setRows((current) => ({ ...current, [field]: next }));
    commitRows(field, next);
  };

  const chooseWorkspaceRoot = async (entryId: string): Promise<void> => {
    const entry = rows.workspaceRoots.find(
      (candidate) => candidate.id === entryId,
    );
    if (entry === undefined) return;
    const selected = await selectDirectory(entry.value);
    if (selected === undefined) return;
    const next = rows.workspaceRoots.map((candidate) =>
      candidate.id === entryId ? { ...candidate, value: selected } : candidate,
    );
    setRows((current) => ({ ...current, workspaceRoots: next }));
    commitRows("workspaceRoots", next);
  };

  const selectProfile = (id: string): void => {
    const selected = profiles.find((profile) => profile.id === id);
    if (selected === undefined || onProfileSwitch === undefined) return;
    const sent = generation.current;
    void onProfileSwitch(id).then((result) => {
      // A patch that started during the switch owns the profile state now.
      if (result !== "applied" || generation.current !== sent) return;
      adopt(profileValuesFor(selected));
    });
  };

  return {
    persisted,
    scalars,
    rows,
    status,
    editScalar,
    commitScalar,
    selectAccount,
    editListEntry: (field, entryId, value) =>
      setRows((current) => ({
        ...current,
        [field]: current[field].map((entry) =>
          entry.id === entryId ? { ...entry, value } : entry,
        ),
      })),
    commitList: (field) => commitRows(field, rows[field]),
    addListEntry: (field) =>
      setRows((current) => ({
        ...current,
        [field]: [...current[field], profileListEntry("")],
      })),
    removeListEntry,
    chooseWorkspaceRoot,
    selectProfile,
  };
}

const IDLE: FieldStatus = { state: "idle" };
const SAVING: FieldStatus = { state: "saving" };
const SAVED: FieldStatus = { state: "saved" };

const IDLE_STATUS: ProfileFieldStatuses = {
  label: IDLE,
  githubHost: IDLE,
  ghAccount: IDLE,
  workspaceRoots: IDLE,
  rulePaths: IDLE,
};
