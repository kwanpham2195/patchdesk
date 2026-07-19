import { randomBytes, timingSafeEqual } from "node:crypto";

import type { AppCapability } from "./ipc-contract";

/** Generates a high-entropy, process-local API capability. */
export function createAppCapability(): AppCapability {
  return randomBytes(32).toString("base64url");
}

/** Compares a presented capability without exposing a timing oracle for equal-length values. */
export function hasMatchingAppCapability(
  expected: AppCapability,
  presented: string | undefined,
): boolean {
  if (presented === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  return (
    expectedBytes.length === presentedBytes.length &&
    timingSafeEqual(expectedBytes, presentedBytes)
  );
}
