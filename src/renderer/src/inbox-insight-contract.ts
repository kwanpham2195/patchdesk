import * as v from "valibot";

import { INBOX_INSIGHT_STATES } from "../../domain/maintainer-inbox";

/**
 * Strict renderer wire-boundary schema for a row's Insight readiness: one
 * optional state per kind, absent wherever nothing is retained.
 */
export const inboxInsightReadinessSchema = v.strictObject({
  brief: v.optional(v.picklist(INBOX_INSIGHT_STATES)),
  analysis: v.optional(v.picklist(INBOX_INSIGHT_STATES)),
  walkthrough: v.optional(v.picklist(INBOX_INSIGHT_STATES)),
});
