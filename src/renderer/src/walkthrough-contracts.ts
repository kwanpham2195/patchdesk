import * as v from "valibot";
import {
  walkthroughPageSchema,
  walkthroughSummarySchema,
  type WalkthroughPage,
  type WalkthroughSummary,
} from "#src/domain/walkthrough-progress";
import type { RawJsonValue } from "#src/domain/json";

/** Strictly parses the bounded bridge reply before rendering it. */
export function parseWalkthroughSummaryReply(
  body: RawJsonValue | undefined,
): WalkthroughSummary | undefined {
  const parsed = v.safeParse(walkthroughSummarySchema, body);
  return parsed.success ? parsed.output : undefined;
}

/** Strictly parses one page, never a legacy whole-result document. */
export function parseWalkthroughPageReply(
  body: RawJsonValue | undefined,
): WalkthroughPage | undefined {
  const parsed = v.safeParse(walkthroughPageSchema, body);
  return parsed.success ? parsed.output : undefined;
}
