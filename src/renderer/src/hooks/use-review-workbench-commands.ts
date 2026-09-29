import { useCallback, useEffect, useState } from "react";

import type { InsightRunDialogType } from "../components/insight-run-dialog";
import type {
  WorkbenchActiveTab,
  WorkbenchPosition,
} from "../lib/screen-restore";
import { focusInsideOverlay } from "../review-diff-keyboard-nav";
import {
  useRegisterReviewCommands,
  type FindingStepSlot,
  type ReviewCommand,
} from "../review-commands";
import { isTextEntryTarget } from "../text-entry-target";
import { useLatestCommitted } from "./use-latest-committed";

/** The workbench tabs in strip order, with the digit that selects each under ⌘. */
const WORKBENCH_TAB_COMMANDS = [
  { tab: "conversation", label: "Conversation", key: "1" },
  { tab: "diff", label: "Diff", key: "2" },
  { tab: "insights", label: "Insights", key: "3" },
] as const satisfies ReadonlyArray<{
  readonly tab: WorkbenchActiveTab;
  readonly label: string;
  readonly key: string;
}>;

const INSIGHT_READER_COMMANDS = [
  { insight: "brief", label: "Brief" },
  { insight: "walkthrough", label: "Walkthrough" },
  { insight: "analysis", label: "Analysis" },
] as const satisfies ReadonlyArray<{
  readonly insight: InsightRunDialogType;
  readonly label: string;
}>;

const FINDING_STEP_UNAVAILABLE = "Works in the Diff with All files.";

/**
 * Owns the workbench's keyboard and ⌘K commands: ⌘1 to ⌘3 select the tabs,
 * and the palette's Review group selects tabs and Insight readers, steps
 * through Findings in the Diff, and opens Finish review. Every command calls
 * the handler the visible control calls; none starts a run or a write.
 */
export function useReviewWorkbenchCommands({
  sessionId,
  hasConversation,
  section,
  commitWorkbenchPosition,
  openFinishReview,
}: {
  readonly sessionId: string;
  /** A local Review has no Conversation tab, so ⌘1 does nothing there. */
  readonly hasConversation: boolean;
  readonly section: WorkbenchPosition["section"];
  readonly commitWorkbenchPosition: (next: WorkbenchPosition) => void;
  /** The header's Finish review handler, set only while the header shows the button. */
  readonly openFinishReview: (() => void) | undefined;
}) {
  const selectTab = useCallback(
    (tab: WorkbenchActiveTab): void =>
      // Insights always opens on files; the other tabs keep the section.
      commitWorkbenchPosition(
        tab === "insights"
          ? { activeTab: tab, section: "files" }
          : { activeTab: tab, section },
      ),
    [commitWorkbenchPosition, section],
  );
  // The Insights slot unmounts while the Diff tab shows, so its reader choice lives here, keyed by session.
  const [rememberedInsight, setRememberedInsight] = useState<
    | { readonly sessionId: string; readonly insight: InsightRunDialogType }
    | undefined
  >(undefined);
  const rememberInsight = useCallback(
    (insight: InsightRunDialogType): void =>
      setRememberedInsight({ sessionId, insight }),
    [sessionId],
  );
  const lastInsight =
    rememberedInsight?.sessionId === sessionId
      ? rememberedInsight.insight
      : undefined;
  const [findingStepSlot] = useState<FindingStepSlot>(() => ({
    current: undefined,
  }));

  const tabCommands = WORKBENCH_TAB_COMMANDS.filter(
    (command) => hasConversation || command.tab !== "conversation",
  );
  const latest = useLatestCommitted({
    tabCommands,
    selectTab,
    rememberInsight,
    openFinishReview,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      const command = latest.current.tabCommands.find(
        (candidate) => candidate.key === event.key,
      );
      if (command === undefined) return;
      if (isTextEntryTarget(event) || focusInsideOverlay()) return;
      event.preventDefault();
      latest.current.selectTab(command.tab);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [latest]);

  const commandSource = useCallback((): ReadonlyArray<ReviewCommand> => {
    const current = latest.current;
    const findingStep = findingStepSlot.current;
    const findingCommand = (
      id: string,
      label: string,
      shortcut: string,
      direction: "previous" | "next",
    ): ReviewCommand =>
      findingStep === undefined
        ? {
            id,
            label,
            shortcut,
            unavailableReason: FINDING_STEP_UNAVAILABLE,
            run: () => undefined,
          }
        : { id, label, shortcut, run: () => findingStep(direction) };
    return [
      ...current.tabCommands.map((command) => ({
        id: `tab-${command.tab}`,
        label: command.label,
        shortcut: `⌘${command.key}`,
        run: () => current.selectTab(command.tab),
      })),
      ...INSIGHT_READER_COMMANDS.map((command) => ({
        id: `insight-${command.insight}`,
        label: command.label,
        run: () => {
          current.rememberInsight(command.insight);
          current.selectTab("insights");
        },
      })),
      findingCommand("next-finding", "Next Finding", ")", "next"),
      findingCommand("previous-finding", "Previous Finding", "(", "previous"),
      ...(current.openFinishReview === undefined
        ? []
        : [
            {
              id: "finish-review",
              label: "Finish review",
              run: current.openFinishReview,
            },
          ]),
    ];
  }, [findingStepSlot, latest]);
  useRegisterReviewCommands(commandSource);

  return {
    lastInsight,
    rememberInsight,
    selectTab,
    findingStepSlot,
  };
}
