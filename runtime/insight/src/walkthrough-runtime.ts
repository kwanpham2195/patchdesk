import { runExplanationSession } from "./explanation-runtime";
import type { WalkthroughSessionInvocation } from "./patchdesk-insight-agent";
import type { PatchdeskChildResult } from "./patchdesk-insight-runner";

/** Walkthrough uses strict citation tools and aborts at the exact durable generation deadline. */
export function runWalkthroughSession(
  invocation: WalkthroughSessionInvocation,
  options: Omit<Parameters<typeof runExplanationSession>[1], "openChannel">,
): Promise<PatchdeskChildResult> {
  return runExplanationSession(invocation, options, {
    deadlineAt: invocation.deadlineAt,
  });
}
