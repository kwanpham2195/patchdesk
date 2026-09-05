import type { ComponentProps } from "react";

import { InboxFlow } from "../../src/renderer/src/flows/inbox-flow";
import { useInboxReviewOpening } from "../../src/renderer/src/flows/use-inbox-review-opening";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { Dashboard } from "../../src/renderer/src/renderer-models";

type InboxFlowHarnessProps = Omit<
  ComponentProps<typeof InboxFlow>,
  "dashboard" | "reviewOpening"
> & {
  readonly dashboard?: Dashboard;
  readonly onOpenWorkbench: (workbench: WorkbenchResponse) => void;
};

/** Owns the Review-opening hook around direct InboxFlow component tests. */
export function InboxFlowHarness({
  onOpenWorkbench,
  dashboard,
  ...props
}: InboxFlowHarnessProps): React.JSX.Element {
  const reviewOpening = useInboxReviewOpening({
    dashboard,
    onOpenWorkbench,
  });
  return (
    <InboxFlow
      {...props}
      {...(dashboard === undefined ? {} : { dashboard })}
      reviewOpening={reviewOpening}
    />
  );
}
