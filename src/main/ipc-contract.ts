import { randomBytes, timingSafeEqual } from "node:crypto";

/** Header accepted by the loopback API for every request. */
export const APP_CAPABILITY_HEADER = "X-Patchdesk-Capability";

/** Opaque local credential shared with the renderer only through preload. */
export type AppCapability = string;

/** Generates a high-entropy, process-local API capability. */
export function createAppCapability(): AppCapability {
  return randomBytes(32).toString("base64url");
}

/** Compares a presented capability without exposing a timing oracle for equal-length values. */
export function hasMatchingAppCapability(
  expected: AppCapability,
  presented: string | undefined,
): boolean {
  if (presented === undefined) {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);

  return (
    expectedBytes.length === presentedBytes.length &&
    timingSafeEqual(expectedBytes, presentedBytes)
  );
}

/** Represents the narrow local API surface that preload may expose to the renderer. */
export type RendererLocalApi = {
  readonly baseUrl: string;
  readonly capability: AppCapability;
};
