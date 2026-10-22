import {
  guideAppReplySchema,
  type GuideAppOutcome,
  type GuideChildFrame,
} from "#app/domain/guide-protocol";
import type { ExplanationConnectionIdentity } from "#app/domain/explanation-channel";
import {
  openExplanationChannel,
  type ExplanationChannel,
} from "./explanation-child-channel";

type ChannelRequest<T> = T extends unknown
  ? Omit<T, keyof ExplanationConnectionIdentity | "correlation">
  : never;
export type GuideChannel = ExplanationChannel<
  ChannelRequest<GuideChildFrame>,
  GuideAppOutcome
>;

/** The admitted Guide runtime selects its reply schema, never a field supplied by a tool. */
export function openGuideChannel(
  identity: ExplanationConnectionIdentity,
  descriptor = 3,
): GuideChannel {
  return openExplanationChannel<
    ChannelRequest<GuideChildFrame>,
    GuideAppOutcome
  >(identity, guideAppReplySchema, descriptor);
}
