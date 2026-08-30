import { useCallback, useRef, useState } from "react";
import { contextualMessage, requestJson } from "../api-client";
import { useLatestCommitted } from "./use-latest-committed";

/** The profile control that most recently expressed switching intent. */
type ProfileSwitchOwner = "header" | "settings";

/** Shared pending and error state for both profile entry points. */
export type ProfileSwitchState = {
  readonly pendingTarget: string | undefined;
  readonly pendingOwner: ProfileSwitchOwner | undefined;
  readonly error:
    | { readonly owner: ProfileSwitchOwner; readonly message: string }
    | undefined;
};

/** Whether a profile-switch caller still owned the latest intent at settlement. */
export type ProfileSwitchResult = "applied" | "failed" | "obsolete";

/** Profile-switch state and command shared by Header and Settings. */
export type ProfileSwitchController = {
  readonly profileSwitchState: ProfileSwitchState;
  readonly switchProfile: (
    profileId: string,
    owner: ProfileSwitchOwner,
  ) => Promise<ProfileSwitchResult>;
};

const INITIAL_PROFILE_SWITCH_STATE: ProfileSwitchState = {
  pendingTarget: undefined,
  pendingOwner: undefined,
  error: undefined,
};

/**
 * Persists profile selection once per target while applying only the latest
 * intent across the Header and Settings entry points.
 */
export function useProfileSwitch(
  onLatestSuccess: (profileId: string) => Promise<void>,
): ProfileSwitchController {
  const [profileSwitchState, setProfileSwitchState] =
    useState<ProfileSwitchState>(INITIAL_PROFILE_SWITCH_STATE);
  const intentGeneration = useRef(0);
  const requestsByTarget = useRef(new Map<string, Promise<void>>());
  const onLatestSuccessRef = useLatestCommitted(onLatestSuccess);

  const switchProfile = useCallback(
    async (
      profileId: string,
      owner: ProfileSwitchOwner,
    ): Promise<ProfileSwitchResult> => {
      const generation = ++intentGeneration.current;
      setProfileSwitchState({
        pendingTarget: profileId,
        pendingOwner: owner,
        error: undefined,
      });

      let request = requestsByTarget.current.get(profileId);
      if (request === undefined) {
        request = requestJson("/v1/profiles/select", {
          method: "POST",
          body: { id: profileId },
        }).then(() => undefined);
        requestsByTarget.current.set(profileId, request);
        const releaseRequest = (): void => {
          if (requestsByTarget.current.get(profileId) === request)
            requestsByTarget.current.delete(profileId);
        };
        void request.then(releaseRequest, releaseRequest);
      }

      try {
        await request;
        if (intentGeneration.current !== generation) return "obsolete";
        await onLatestSuccessRef.current(profileId);
        if (intentGeneration.current !== generation) return "obsolete";
        setProfileSwitchState(INITIAL_PROFILE_SWITCH_STATE);
        return "applied";
      } catch (cause: unknown) {
        if (intentGeneration.current !== generation) return "obsolete";
        setProfileSwitchState({
          pendingTarget: undefined,
          pendingOwner: undefined,
          error: {
            owner,
            message: contextualMessage(cause, {
              fallback: "Patchdesk could not switch profiles.",
            }),
          },
        });
        return "failed";
      }
    },
    [onLatestSuccessRef],
  );

  return { profileSwitchState, switchProfile };
}
