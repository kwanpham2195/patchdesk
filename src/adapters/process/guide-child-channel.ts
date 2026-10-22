import {
  guideChildFrameSchema,
  type GuideAppOutcome,
  type GuideChildFrame,
} from "#src/domain/guide-protocol";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import {
  runExplanationChild,
  type ExplanationChildExit,
} from "./explanation-child-channel";

/** The admitted Guide invocation selects the closed schema before the child can send any frame. */
export function runGuideChild(input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly signal?: AbortSignal | undefined;
  readonly identity: ExplanationConnectionIdentity;
  readonly handler: (frame: GuideChildFrame) => Promise<GuideAppOutcome>;
}): Promise<ExplanationChildExit> {
  return runExplanationChild({
    ...input,
    frameSchema: guideChildFrameSchema,
    storageFailure: { status: "refused", reason: "storage" },
  });
}
