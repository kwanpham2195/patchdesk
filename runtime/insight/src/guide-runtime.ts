import { runExplanationSession } from "./explanation-runtime";
import type { GuideSessionInvocation } from "./patchdesk-insight-agent";
import type { PatchdeskChildResult } from "./patchdesk-insight-runner";

/** Guide retains its existing channel, wire format and no-total-deadline policy. */
export function runGuideSession(
  invocation: GuideSessionInvocation,
  options: Parameters<typeof runExplanationSession>[1],
): Promise<PatchdeskChildResult> {
  return runExplanationSession(invocation, options);
}
