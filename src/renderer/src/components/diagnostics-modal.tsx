import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";

import { ReviewActivityCard } from "../flows/review-activity-card";
import { LogsPanel } from "./logs-panel";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

type DiagnosticsSection = "logs" | "activity";

/** The Help → Diagnostics overlay: the app Logs tail and the active profile's Review activity. */
export function DiagnosticsModal({
  open,
  onOpenChange,
  opener,
  profileId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly opener: HTMLElement | undefined;
  readonly profileId: string | undefined;
}): React.JSX.Element {
  const [section, setSection] = useState<DiagnosticsSection>("logs");
  const openerRef = useRef<HTMLElement | null>(null);
  const lastOpen = useRef(false);

  useEffect(() => {
    if (open && !lastOpen.current) openerRef.current = opener ?? null;
    if (!open && lastOpen.current) {
      openerRef.current?.focus();
      openerRef.current = null;
    }
    lastOpen.current = open;
  }, [open, opener]);
  // Resetting on close makes the next open start on Logs.
  const changeOpen = (next: boolean): void => {
    if (!next) setSection("logs");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(90vh,960px)] max-h-[90vh] w-[min(96vw,1200px)] max-w-[min(96vw,1200px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1200px)]"
        aria-describedby="diagnostics-description"
      >
        <DialogHeader className="border-b px-10 py-8">
          <DialogTitle className="flex items-center gap-2">
            <Activity /> Diagnostics
          </DialogTitle>
          <DialogDescription id="diagnostics-description">
            Local evidence for troubleshooting Patchdesk.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={section}
          onValueChange={(value) => {
            if (value === "logs" || value === "activity") setSection(value);
          }}
          orientation="horizontal"
          className="min-h-0 flex-1 gap-0"
        >
          <TabsList
            variant="line"
            className="mx-10 mt-8"
            aria-label="Diagnostics sections"
          >
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="activity">Review activity</TabsTrigger>
          </TabsList>
          <div
            role="region"
            aria-label="Diagnostics content"
            className="min-h-0 flex-1"
          >
            <ScrollArea className="h-full px-10 py-8">
              <TabsContent value={section} className="mt-0">
                {section === "logs" ? (
                  <LogsPanel />
                ) : (
                  <ReviewActivityCard profileId={profileId} />
                )}
              </TabsContent>
            </ScrollArea>
          </div>
        </Tabs>
        <Separator />
        <DialogFooter className="rounded-b-xl border-0 px-10 py-6">
          <Button variant="outline" onClick={() => changeOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
