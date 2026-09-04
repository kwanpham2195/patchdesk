import { BookOpen, FileText, Sparkles, type LucideIcon } from "lucide-react";

import type { InsightRunDialogType } from "./components/insight-run-dialog";

/** The one glyph per Insight type, so every surface names the same thing the same way. */
export const INSIGHT_ICONS = {
  brief: FileText,
  analysis: Sparkles,
  walkthrough: BookOpen,
} as const satisfies Record<InsightRunDialogType, LucideIcon>;
