import { ChevronDownIcon } from "lucide-react";

import type { AnalysisResult } from "../analysis-headline";
import {
  GeneratedMarkdown,
  GeneratedMarkdownInline,
} from "./generated-markdown";
import { analysisFindingRowId } from "./review-workbench-finding-navigation";
import { Badge } from "./ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

/** A dismissed Finding kept in the list at one line, with its reason. */
export function AnalysisDismissedFindingRow({
  finding,
  location,
}: {
  readonly finding: AnalysisResult["findings"][number];
  readonly location: string | undefined;
}): React.JSX.Element {
  return (
    // Focusable so a Diff card's "Open in Analysis" can land keyboard focus here.
    <li
      id={analysisFindingRowId(finding.id)}
      tabIndex={-1}
      className="rounded-lg border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Badge variant="outline">{finding.severity}</Badge>
          <span className="min-w-0 shrink truncate">
            <GeneratedMarkdownInline markdown={finding.title} />
          </span>
          <span className="min-w-0 flex-1 truncate">
            Dismissed
            {finding.dismissalReason === undefined
              ? null
              : `: ${finding.dismissalReason}`}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent motion="disclosure">
          <div className="px-3 pb-3">
            <GeneratedMarkdown
              markdown={finding.explanation}
              className="max-w-4xl text-muted-foreground"
            />
            {location === undefined ? null : (
              <p className="mt-2 truncate text-xs text-muted-foreground">
                {location}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
