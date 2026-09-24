import { Reply } from "lucide-react";

import { Badge } from "./ui/badge";

/** Shared by the Threads list and Analysis Finding rows so both draw the same glyph. */
export function NeedsReplyBadge(): React.JSX.Element {
  return (
    <Badge variant="warning">
      <Reply aria-hidden="true" />
      Needs your reply
    </Badge>
  );
}
