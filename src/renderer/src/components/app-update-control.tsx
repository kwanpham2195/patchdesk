import { useEffect, useState } from "react";
import { CircleArrowUp, CircleCheck, TriangleAlert } from "lucide-react";

import {
  MANUAL_UPDATE_COMMAND,
  type AppUpdateState,
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
          <PopoverDescription>
            Homebrew upgraded the app and the <code>patchdesk</code> command.
          </PopoverDescription>
        </PopoverHeader>
        <AppUpdateActions notice="launch" />
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
          <PopoverDescription>Homebrew's output is in:</PopoverDescription>
        </PopoverHeader>
        <code className="font-mono text-xs break-all text-muted-foreground">
          {launchNotice.logPath}
        </code>
        <ManualUpdateCommand />
        <AppUpdateActions notice="launch" copyCommand />
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
      {available.install === "homebrew" ? (
        <>
          <p className="text-muted-foreground">
            Patchdesk quits, upgrades with Homebrew, and opens again.
          </p>
          <AppUpdateActions notice="available" disabled={available.installing}>
            <Button
              size="sm"
              disabled={available.installing}
              onClick={() =>
                void window.patchdesk.request({ operation: "installAppUpdate" })
              }
            >
              {available.installing ? "Quitting to update…" : "Update now"}
            </Button>
          </AppUpdateActions>
        </>
      ) : (
        <>
          <ManualUpdateCommand />
          <AppUpdateActions notice="available" copyCommand />
        </>
      )}
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

function ManualUpdateCommand(): React.JSX.Element {
  return (
    <>
      <p className="text-muted-foreground">
        To update by hand, run this in Terminal:
      </p>
      <pre className="rounded-md bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap">
        {MANUAL_UPDATE_COMMAND}
      </pre>
    </>
  );
}

/** The popover's footer: Copy command on the left when offered, then Dismiss and the primary action. */
function AppUpdateActions({
  notice,
  copyCommand = false,
  disabled = false,
  children,
}: {
  readonly notice: "available" | "launch";
  readonly copyCommand?: boolean;
  readonly disabled?: boolean;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2">
      {copyCommand ? (
        <CopyLoadedTextButton
          label="Copy command"
          load={async () => MANUAL_UPDATE_COMMAND}
          failure="The command could not be copied."
        />
      ) : null}
      <div className="ml-auto flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => dismiss(notice)}
        >
          Dismiss
        </Button>
        {children}
      </div>
    </div>
  );
}
