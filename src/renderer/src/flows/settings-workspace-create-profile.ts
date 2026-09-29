import { requestJson } from "../api-client";
import { parseCreatedProfileId } from "../renderer-contracts";
import {
  profileRequestBody,
  type ProfileValues,
} from "./settings-workspace-profile-values";

/**
 * Creates one workspace and makes it the active one, for the New workspace
 * dialog, the only surface that creates. The id is derived from the label by
 * the service (`POST /v1/profiles` without an id) and returned. A failure
 * throws with a message the caller renders as it is.
 */
export async function createWorkspaceProfile(
  values: ProfileValues,
): Promise<string> {
  const { id: _unused, ...withoutId } = profileRequestBody(values);
  const created = await requestJson("/v1/profiles", {
    method: "POST",
    body: withoutId,
  });
  const id = parseCreatedProfileId(created);
  if (id === undefined)
    throw new Error("Patchdesk could not read the created workspace.");
  await requestJson("/v1/profiles/select", {
    method: "POST",
    body: { id },
  });
  return id;
}
