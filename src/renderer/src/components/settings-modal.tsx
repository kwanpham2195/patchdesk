import { useEffect, useRef, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";

import type { DiffThemePreferences } from "../diff-theme-preferences";
import type { AppearancePreference } from "../appearance-preferences";
import type { Dashboard, Profile, Repo } from "../renderer-models";
import { SettingsFlow, type SettingsSection } from "../flows/settings-flow";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export type SettingsModalProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly dashboard?: Dashboard;
  readonly appearance: AppearancePreference;
  readonly onAppearanceChange: (value: AppearancePreference) => void;
  readonly diffThemePreferences: DiffThemePreferences;
  readonly onDiffThemeChange: (value: DiffThemePreferences) => void;
  readonly profiles: ReadonlyArray<Profile>;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onRepositoryRefresh?: (value: unknown, repo: Repo) => void;
  readonly opener?: HTMLElement | null | undefined;
};

/** Global, General-first Settings overlay that preserves the underlying route. */
export function SettingsModal({
  open,
  onOpenChange,
  opener,
  ...flowProps
}: SettingsModalProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>("general");
  const [dirty, setDirty] = useState(false);
  const [dirtyDialogOpen, setDirtyDialogOpen] = useState(false);
  const pendingSwitch = useRef<(() => void) | undefined>(undefined);
  const lastOpen = useRef(false);

  useEffect(() => {
    if (open && !lastOpen.current) setSection("general");
    if (!open && lastOpen.current && opener !== null && opener !== undefined) opener.focus();
    lastOpen.current = open;
  }, [open, opener]);

  const requestClose = (nextOpen: boolean): void => {
    if (nextOpen || !dirty) {
      onOpenChange(nextOpen);
      return;
    }
    setDirtyDialogOpen(true);
  };

  const requestProfileSwitch = (_profileId: string, proceed: () => void): void => {
    if (!dirty) {
      proceed();
      return;
    }
    pendingSwitch.current = proceed;
    setDirtyDialogOpen(true);
  };

  const discardAndContinue = (): void => {
    setDirty(false);
    setDirtyDialogOpen(false);
    const proceed = pendingSwitch.current;
    pendingSwitch.current = undefined;
    if (proceed !== undefined) proceed();
    else onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent showCloseButton={false} className="max-h-[min(88vh,760px)] max-w-4xl gap-0 p-0" aria-describedby="settings-description">
          <DialogHeader className="border-b p-5 pb-4">
            <DialogTitle className="flex items-center gap-2"><SettingsIcon /> Settings</DialogTitle>
            <DialogDescription id="settings-description">Centered overlay. Always starts on General and returns to the underlying route on close.</DialogDescription>
          </DialogHeader>
          <Tabs value={section} onValueChange={(value) => { if (value === "general" || value === "review" || value === "data") setSection(value); }} orientation="horizontal" className="min-h-0 gap-0">
            <TabsList className="mx-5 mt-4" aria-label="Settings sections">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="review">Review</TabsTrigger>
              <TabsTrigger value="data">Data &amp; recovery</TabsTrigger>
            </TabsList>
            <ScrollArea className="max-h-[min(68vh,560px)] min-h-0 px-5 py-4" aria-label="Settings content">
              <TabsContent value={section} data-testid={`settings-section-${section}`} className="mt-0"><SettingsFlow {...flowProps} section={section} onDirtyChange={setDirty} onProfileSwitchRequest={requestProfileSwitch} onCleanupSuccess={() => onOpenChange(false)} /></TabsContent>
            </ScrollArea>
          </Tabs>
          <Separator />
          <DialogFooter className="rounded-b-xl border-0">
            <p className="mr-auto text-xs text-muted-foreground">Closing this dialog returns to the underlying route. No data is written automatically.</p>
            <Button variant="outline" onClick={() => requestClose(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={dirtyDialogOpen} onOpenChange={setDirtyDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard profile changes?</AlertDialogTitle>
            <AlertDialogDescription>Save the profile before leaving, discard the draft, or cancel to keep editing.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { pendingSwitch.current = undefined; }}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discardAndContinue}>Discard changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
