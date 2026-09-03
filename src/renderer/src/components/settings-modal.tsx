import { useEffect, useRef, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";

import type { DiffThemePreferences } from "../diff-theme-preferences";
import type { AppearancePreference } from "../appearance-preferences";
import type { Dashboard, Profile } from "../renderer-models";
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
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "../lib/utils";
import type {
  ProfileSwitchResult,
  ProfileSwitchState,
} from "../hooks/use-profile-switch";

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
  readonly profileSwitchState?: ProfileSwitchState;
  readonly onProfileSwitch?: (
    profileId: string,
  ) => Promise<ProfileSwitchResult>;
  readonly opener?: HTMLElement | null | undefined;
  readonly onCleanupSuccess?: (action: "cache" | "local") => void;
  readonly preferenceError?: string | undefined;
  readonly onRetryPreferences?: () => void;
  /** Section to open on; defaults to General when the caller does not target one. */
  readonly initialSection?: SettingsSection;
  /** Reports section switches so the parent can persist a reload restore. */
  readonly onSectionChange?: (section: SettingsSection) => void;
};

/** Global, General-first Settings overlay that preserves the underlying route. */
export function SettingsModal({
  open,
  onOpenChange,
  opener,
  initialSection,
  onSectionChange,
  ...flowProps
}: SettingsModalProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>(
    initialSection ?? "general",
  );
  const openerRef = useRef<HTMLElement | null>(null);
  const lastOpen = useRef(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- the section is the only state left after the profile draft moved into the Workspace editor, and reopening must land on the section the caller asked for. Remounting on a `key` instead would drop the opener the close path focuses.
  useEffect(() => {
    if (open && !lastOpen.current) {
      setSection(initialSection ?? "general");
      openerRef.current = opener ?? null;
    }
    if (!open && lastOpen.current) {
      openerRef.current?.focus();
      openerRef.current = null;
    }
    lastOpen.current = open;
  }, [open, opener, initialSection]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex w-[min(96vw,1200px)] max-w-[min(96vw,1200px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1200px)]",
          section === "workspace" || section === "data" || section === "logs"
            ? "h-[min(90vh,960px)] max-h-[90vh]"
            : "max-h-[90vh]",
        )}
        aria-describedby="settings-description"
      >
        <DialogHeader className="border-b px-10 py-8">
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon /> Settings
          </DialogTitle>
          <DialogDescription id="settings-description">
            Set Patchdesk appearance and diff themes.
          </DialogDescription>
          {flowProps.preferenceError === undefined ? null : (
            <Alert variant="destructive" className="mt-3">
              <AlertTitle>Preference error</AlertTitle>
              <AlertDescription>
                {flowProps.preferenceError}{" "}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={flowProps.onRetryPreferences}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </DialogHeader>
        <Tabs
          value={section}
          onValueChange={(value) => {
            if (
              value === "general" ||
              value === "workspace" ||
              value === "review" ||
              value === "data" ||
              value === "logs"
            ) {
              setSection(value);
              onSectionChange?.(value);
            }
          }}
          orientation="horizontal"
          className="min-h-0 flex-1 gap-0"
        >
          <TabsList
            variant="line"
            className="mx-10 mt-8"
            aria-label="Settings sections"
          >
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="workspace">Workspace</TabsTrigger>
            <TabsTrigger value="review">Review</TabsTrigger>
            <TabsTrigger value="data">Data &amp; recovery</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>
          <div
            role="region"
            aria-label="Settings content"
            data-testid="settings-scroll-region"
            className="min-h-0 flex-1"
          >
            <ScrollArea className="h-full px-10 py-8">
              <TabsContent
                value={section}
                data-testid={`settings-section-${section}`}
                className="mt-0"
              >
                <SettingsFlow
                  {...flowProps}
                  section={section}
                  onCleanupSuccess={(action) => {
                    onOpenChange(false);
                    flowProps.onCleanupSuccess?.(action);
                  }}
                />
              </TabsContent>
            </ScrollArea>
          </div>
        </Tabs>
        <Separator />
        <DialogFooter className="rounded-b-xl border-0 px-10 py-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
