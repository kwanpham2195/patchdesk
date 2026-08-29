import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { SettingsSection } from "../flows/settings-flow";
import { loadSettingsRestore } from "../lib/screen-restore";
import type { NavigationState } from "./use-app-navigation";

/**
 * The Settings overlay: whether it is open, which section it shows, and the
 * element focus returns to when it closes.
 *
 * The overlay refuses to open while navigation is blocked, which is why the
 * hook takes `navigationState` rather than reading it back from the screen.
 */
export type SettingsOverlay = {
  readonly settingsOpen: boolean;
  readonly setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  readonly settingsOpener: HTMLElement | undefined;
  readonly setSettingsOpener: Dispatch<SetStateAction<HTMLElement | undefined>>;
  readonly settingsSection: SettingsSection;
  readonly openSettings: (
    opener?: HTMLElement,
    section?: SettingsSection,
  ) => void;
};

export function useSettingsOverlay({
  fixtureMode,
  navigationState,
}: {
  readonly fixtureMode: boolean;
  readonly navigationState: NavigationState;
}): SettingsOverlay {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsOpener, setSettingsOpener] = useState<
    HTMLElement | undefined
  >();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    () => restoredSettingsSection() ?? "general",
  );
  // A reload with Settings open reopens the overlay on the same section.
  useEffect(() => {
    if (fixtureMode || settingsOpen || loadSettingsRestore() === undefined)
      return;
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- `fixtureMode` is a guard, not a value copied into state; it only ever stops this effect. The rule sees it as a prop only because the effect now lives in a hook instead of inline in `App`, and the guard itself goes away with S4c's FixtureApp/App split.
    setSettingsOpen(true);
  }, [fixtureMode, settingsOpen]);
  useEffect(() => {
    if (fixtureMode) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        if (navigationState === "clear") {
          setSettingsOpener(
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : undefined,
          );
          setSettingsOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fixtureMode, navigationState]);
  const openSettings = useCallback(
    (opener?: HTMLElement, section?: SettingsSection): void => {
      if (navigationState !== "clear") return;
      const fallback =
        document.querySelector<HTMLElement>("[data-settings-opener]") ??
        document.querySelector<HTMLElement>("#main-content");
      setSettingsOpener(opener ?? fallback ?? undefined);
      setSettingsSection(section ?? "general");
      setSettingsOpen(true);
    },
    [navigationState],
  );
  return {
    openSettings,
    settingsOpen,
    setSettingsOpen,
    settingsOpener,
    setSettingsOpener,
    settingsSection,
  };
}

function restoredSettingsSection(): SettingsSection | undefined {
  const restored = loadSettingsRestore();
  if (restored === undefined) return undefined;
  return restored.section === "general" ||
    restored.section === "workspace" ||
    restored.section === "review" ||
    restored.section === "data" ||
    restored.section === "logs"
    ? restored.section
    : undefined;
}
