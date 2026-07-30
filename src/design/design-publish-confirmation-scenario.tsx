import { useState } from "react";
import { GitMerge, MessageSquare, ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../renderer/src/components/ui/alert";
import { Badge } from "../renderer/src/components/ui/badge";
import { Button } from "../renderer/src/components/ui/button";
import { Checkbox } from "../renderer/src/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../renderer/src/components/ui/dialog";
import { Label } from "../renderer/src/components/ui/label";

export type DesignPublishConfirmationVariant = "submit" | "merge";

export function DesignPublishConfirmationScenario({
  variant,
}: {
  readonly variant: DesignPublishConfirmationVariant;
}): React.JSX.Element {
  return variant === "submit" ? <DesignSubmitConfirmation /> : <DesignMergeConfirmation />;
}

function DesignSubmitConfirmation(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <main className="min-h-screen bg-background p-6">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="design-submit-confirmation">
          <DialogHeader>
            <DialogTitle>Apply this review batch to GitHub?</DialogTitle>
            <DialogDescription>
              Review the exact saved actions before creating a pending review.
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <MessageSquare />
            <AlertTitle>Saved actions</AlertTitle>
            <AlertDescription>
              <span data-testid="submit-action-summary">
                2 inline comments · 1 reply · 1 thread change
              </span>
            </AlertDescription>
          </Alert>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">centraldigital/patchdesk#42</p>
            <p className="mt-1 text-muted-foreground">
              Protect review writes · create pending review
            </p>
          </div>
          {confirmed ? (
            <p role="status" className="text-sm text-primary">
              Pending review confirmation recorded locally.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setConfirmed(true)}>
              Create pending review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

const MERGE_WARNINGS = [
  "Required checks are failing",
  "1 high-severity finding remains",
] as const;

function DesignMergeConfirmation(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <main className="min-h-screen bg-background p-6">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="design-merge-confirmation">
          <DialogHeader>
            <DialogTitle>Confirm merge</DialogTitle>
            <DialogDescription>
              Confirm the exact pull request, head SHA, method, and warnings.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">centraldigital/patchdesk#42</p>
            <p className="mt-1 text-muted-foreground">sit ← feat/review</p>
            <code className="mt-2 block break-all">abcdef1234567890</code>
            <Badge className="mt-2" variant="secondary">Squash</Badge>
          </div>
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>Before you merge</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-5">
                {MERGE_WARNINGS.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
          <div className="flex items-start gap-2">
            <Checkbox
              id="design-merge-warning-acknowledgement"
              checked={acknowledged}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
            />
            <Label htmlFor="design-merge-warning-acknowledgement" className="leading-5">
              I acknowledge that required checks are failing
            </Label>
          </div>
          {confirmed ? (
            <p role="status" className="text-sm text-primary">
              Merge confirmation recorded locally.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!acknowledged}
              onClick={() => setConfirmed(true)}
            >
              <GitMerge /> Confirm merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
