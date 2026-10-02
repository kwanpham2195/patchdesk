import { useEffect, useState } from "react";
import { CircleArrowUp, CircleCheck, TriangleAlert } from "lucide-react";

import {
  MANUAL_UPDATE_COMMAND,
  type AppUpdateState,
  type AvailableAppUpdate,
} from "../../../domain/app-update";
import { CopyLoadedTextButton } from "@/components/copy-loaded-text-button";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The update state the main process owns (#800): seeded from preload's read
 * and kept current by its pushes. Outside Electron the bridge member is
 * absent and nothing shows.
 */
function useAppUpdateState(): AppUpdateState {
  const [state, setState] = useState<AppUpdateState>(
    () => window.patchdesk?.appUpdateAtLoad ?? {},
  );
  useEffect(() => {
    if (window.patchdesk?.onAppUpdate === undefined) return;
    return window.patchdesk.onAppUpdate(setState);
  }, []);
  return state;
}

function dismiss(notice: "available" | "launch"): void {
  void window.patchdesk.request({ operation: "dismissAppUpdate", notice });
}

/**
 * The title-bar control beside Settings: this launch's update outcome first,
 * then a newer release until it is dismissed. Hidden when there is neither.
 */
export function AppUpdateControl(): React.JSX.Element | null {
  const { available, launchNotice } = useAppUpdateState();
  if (launchNotice?.kind === "updated")
    return (
      <AppUpdatePopover
        icon={<CircleCheck />}
        label={`Updated to ${launchNotice.version}`}
      >
        <PopoverHeader>
          <PopoverTitle>
            Updated to Patchdesk {launchNotice.version}
          </PopoverTitle>
        </PopoverHeader>
        <DismissButton notice="launch" />
      </AppUpdatePopover>
    );
  if (launchNotice?.kind === "updateFailed")
    return (
      <AppUpdatePopover
        icon={<TriangleAlert className="text-destructive" />}
        label="Update did not finish"
      >
        <PopoverHeader>
          <PopoverTitle>The update did not finish</PopoverTitle>
          <PopoverDescription>
            Homebrew's output is in{" "}
            <code className="break-all">{launchNotice.logPath}</code>. To update
            by hand, run this in Terminal:
          </PopoverDescription>
        </PopoverHeader>
        <ManualUpdateCommand />
        <DismissButton notice="launch" />
      </AppUpdatePopover>
    );
  if (available === undefined) return null;
  return (
    <AppUpdatePopover
      icon={<CircleArrowUp />}
      label={`${available.version} available`}
    >
      <PopoverHeader>
        <PopoverTitle>Patchdesk {available.version} is available</PopoverTitle>
        <PopoverDescription>
          <Button
            variant="link"
            onClick={() =>
              void window.patchdesk.openExternalHttps(available.releaseUrl)
            }
          >
            Read the release notes
          </Button>
        </PopoverDescription>
      </PopoverHeader>
      <AvailableUpdateAction available={available} />
      <DismissButton notice="available" disabled={available.installing} />
    </AppUpdatePopover>
  );
}

function AppUpdatePopover({
  icon,
  label,
  children,
}: {
  readonly icon: React.JSX.Element;
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
        {icon}
        {label}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function AvailableUpdateAction({
  available,
}: {
  readonly available: AvailableAppUpdate;
}): React.JSX.Element {
  if (available.install === "manual")
    return (
      <>
        <p className="text-muted-foreground">
          To update a Homebrew install, run this in Terminal:
        </p>
        <ManualUpdateCommand />
      </>
    );
  return (
    <>
      <p className="text-muted-foreground">
        Patchdesk quits, upgrades with Homebrew, and opens again.
      </p>
      <Button
        size="sm"
        className="self-start"
        disabled={available.installing}
        onClick={() =>
          void window.patchdesk.request({ operation: "installAppUpdate" })
        }
      >
        {available.installing ? "Quitting to update…" : "Update now"}
      </Button>
    </>
  );
}

function ManualUpdateCommand(): React.JSX.Element {
  return (
    <>
      <pre className="rounded-md bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap">
        {MANUAL_UPDATE_COMMAND}
      </pre>
      <CopyLoadedTextButton
        label="Copy command"
        load={async () => MANUAL_UPDATE_COMMAND}
        failure="The command could not be copied."
      />
    </>
  );
}

function DismissButton({
  notice,
  disabled = false,
}: {
  readonly notice: "available" | "launch";
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="self-end"
      disabled={disabled}
      onClick={() => dismiss(notice)}
    >
      Dismiss
    </Button>
  );
}
