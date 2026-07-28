import { useEffect, useState } from "react";
import { AlertTriangle, Inbox, Settings as SettingsIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../renderer/src/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../renderer/src/components/ui/alert-dialog";
import { Button } from "../renderer/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../renderer/src/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../renderer/src/components/ui/dialog";
import { Label } from "../renderer/src/components/ui/label";
import { ScrollArea } from "../renderer/src/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../renderer/src/components/ui/select";
import { Separator } from "../renderer/src/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../renderer/src/components/ui/tabs";
import { cleanupCopy, type CleanupActionKey } from "../renderer/src/review-copy";

type SettingsSection = "general" | "review" | "data";

/**
 * Browser-only Settings overlay. The Design app opens it as a centered modal
 * over the current scenario route, so it is not a destination in the renderer
 * shell. It always starts on General and uses only the local copy map. The
 * optional `autoOpenCleanup` and `onCleanupDialogChange` props let the
 * `dialog-clear-local-data` scenario open a confirmation over a General-first
 * Settings surface without making Data & recovery the first visible section.
 */
export function DesignSettingsOverlay({
  onClose,
  initialSection = "general",
  autoOpenCleanup,
  onCleanupDialogChange,
}: {
  readonly onClose: () => void;
  readonly initialSection?: SettingsSection;
  readonly autoOpenCleanup?: CleanupActionKey | undefined;
  readonly onCleanupDialogChange?: (next: CleanupActionKey | undefined) => void;
}): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [pendingCleanup, setPendingCleanup] = useState<CleanupActionKey | undefined>(autoOpenCleanup);

  useEffect(() => {
    if (autoOpenCleanup !== undefined) setPendingCleanup(autoOpenCleanup);
  }, [autoOpenCleanup]);

  const updatePending = (next: CleanupActionKey | undefined): void => {
    setPendingCleanup(next);
    onCleanupDialogChange?.(next);
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent
          className="max-w-3xl"
          aria-describedby="patchdesk-settings-description"
        >
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="size-4" /> Settings
          </DialogTitle>
          <DialogDescription id="patchdesk-settings-description">
            Centered overlay. Always starts on General and returns to the underlying route on close.
          </DialogDescription>
          <Tabs value={section} onValueChange={(value) => {
            if (value === "general" || value === "review" || value === "data") setSection(value);
          }} orientation="horizontal" className="gap-3">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="review">Review</TabsTrigger>
              <TabsTrigger value="data">Data &amp; recovery</TabsTrigger>
            </TabsList>
            <ScrollArea className="max-h-[60vh] rounded-md border p-2">
              <TabsContent value="general" data-testid="settings-section-general" className="flex flex-col gap-4 p-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Appearance</CardTitle>
                    <CardDescription>Follow the system setting, or keep Patchdesk in light or dark mode.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Label className="grid gap-1.5">Theme
                      <Select defaultValue="dark">
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="system">System</SelectItem>
                          <SelectItem value="light">Light</SelectItem>
                          <SelectItem value="dark">Dark</SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Profile</CardTitle>
                    <CardDescription>Active workspace profile and visible repository paths.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p>CFW · centraldigital</p>
                    <p className="text-muted-foreground">Workspace roots: ~/Work</p>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="review" data-testid="settings-section-review" className="flex flex-col gap-4 p-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Review preferences</CardTitle>
                    <CardDescription>Profile-scoped defaults for the next review run. They never start work.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <Label className="grid gap-1.5">Default model
                      <Select defaultValue="pi-design">
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pi-design">Design review model</SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                    <Label className="grid gap-1.5">Default reasoning
                      <Select defaultValue="medium">
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="data" data-testid="settings-section-data" className="flex flex-col gap-4 p-2">
                <Card data-testid="local-review-data-card">
                  <CardHeader>
                    <CardTitle>Local review data</CardTitle>
                    <CardDescription>
                      Two global actions, ordered by severity. Confirmations state what stays and what goes.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Alert className="border-info/30 bg-info/5">
                      <Inbox />
                      <AlertTitle>Stored reviews stay readable</AlertTitle>
                      <AlertDescription>
                        Reviews you can still open, resume, retry, or prepare remain on this Mac until you remove them yourself.
                      </AlertDescription>
                    </Alert>
                    <div className="flex flex-col gap-2">
                      <Button variant="outline" onClick={() => updatePending("clear_cache")}>Clear cache</Button>
                      <Button variant="outline" data-testid="clear-local-data-button" onClick={() => updatePending("clear_local_review_data")}>Clear local review data</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">Both confirmations disable their controls while pending and retry the same classification on failure.</p>
                  </CardContent>
                </Card>
              </TabsContent>
            </ScrollArea>
          </Tabs>
          <Separator />
          <p className="text-xs text-muted-foreground">Closing this dialog returns to the underlying route. No data is written automatically.</p>
        </DialogContent>
      </Dialog>
      <CleanupDialog pending={pendingCleanup} onCancel={() => updatePending(undefined)} onConfirm={() => updatePending(undefined)} />
    </>
  );
}

function CleanupDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  readonly pending: CleanupActionKey | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  if (pending === undefined) return <></>;
  const copy = cleanupCopy(pending);
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent data-testid={`cleanup-dialog-${pending}`}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4" /> {copy.title}
            </span>
          </AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{copy.confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
