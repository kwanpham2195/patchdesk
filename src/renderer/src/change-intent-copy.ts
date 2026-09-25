import {
  analysisRanAgainstChangeIntent,
  type ChangeIntentSetting,
} from "../../domain/change-intent";
import { isApiErrorCode } from "./api-client";
import type { WorkbenchResponse } from "./renderer-contracts";

type ChangeIntentView = NonNullable<WorkbenchResponse["changeIntent"]>;

/** Why the main process refused an Analysis start on a local Review's spec file (#467), by API error code. */
const CHANGE_INTENT_RUN_REFUSALS = {
  change_intent_file_missing:
    "The spec file is not in the reviewed revision. Fix the path in Change intent, or add the file and press Refresh.",
  change_intent_file_too_large:
    "The spec file is larger than 64 KiB. Shorten it, or enter the goal as text in Change intent.",
  change_intent_file_not_text:
    "The spec file is not UTF-8 text. Point Change intent at a Markdown or text file.",
  change_intent_file_sensitive:
    "The spec file contains what looks like a credential. Remove it and press Refresh.",
} as const;

export type ChangeIntentRunRefusal = keyof typeof CHANGE_INTENT_RUN_REFUSALS;

export function changeIntentRunRefusal(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this reads its error code.
  cause: unknown,
): ChangeIntentRunRefusal | undefined {
  return Object.keys(CHANGE_INTENT_RUN_REFUSALS).find(
    (code): code is ChangeIntentRunRefusal => isApiErrorCode(cause, code),
  );
}

export function changeIntentRunRefusalMessage(
  refusal: ChangeIntentRunRefusal,
): string {
  return CHANGE_INTENT_RUN_REFUSALS[refusal];
}

/** One line for the Review header: the text's first line, or the spec path. */
export function changeIntentSummary(view: ChangeIntentView | null): string {
  if (view === null) return "No change intent";
  if (view.intent.kind === "file") return `Spec: ${view.intent.path}`;
  return (
    view.intent.markdown
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** What an Analysis result says about the intent it checked; undefined when it ran against none. */
export function analysisChangeIntentLine(
  ran: (ChangeIntentSetting & { readonly sha256: string }) | undefined,
  current: ChangeIntentView | null | undefined,
): string | undefined {
  if (ran === undefined) return undefined;
  const checked =
    ran.kind === "text"
      ? "Checked against: change intent"
      : `Checked against: spec ${ran.path}`;
  return analysisRanAgainstChangeIntent(ran, current?.setting)
    ? checked
    : `${checked} · Intent changed since this run`;
}
