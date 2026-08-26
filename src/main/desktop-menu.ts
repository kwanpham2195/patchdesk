import type { MenuItemConstructorOptions } from "electron";

/** Builds a native, role-based desktop menu without renderer privileges. */
export function createDesktopMenuTemplate(
  platform: NodeJS.Platform,
  applicationName: string,
  development: boolean,
  actions: {
    readonly openSettings?: () => void;
    readonly refresh?: () => void;
  } = {},
): ReadonlyArray<MenuItemConstructorOptions> {
  const applicationSettingsItem: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CommandOrControl+,",
  };
  if (actions.openSettings !== undefined)
    applicationSettingsItem.click = actions.openSettings;
  const applicationMenu: MenuItemConstructorOptions = {
    label: applicationName,
    submenu: [
      { role: "about" },
      { type: "separator" },
      applicationSettingsItem,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const fileSettingsItem: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CommandOrControl+,",
  };
  if (actions.openSettings !== undefined)
    fileSettingsItem.click = actions.openSettings;
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      fileSettingsItem,
      { type: "separator" },
      { role: "close" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };
  const refreshItem: MenuItemConstructorOptions = {
    label: "Refresh",
    accelerator: "CommandOrControl+R",
  };
  if (actions.refresh !== undefined) refreshItem.click = actions.refresh;
  const viewItems: MenuItemConstructorOptions[] = [
    refreshItem,
    { type: "separator" },
    ...(development
      ? ([
          // Re-keyed off CommandOrControl+R so that accelerator is free for
          // the data "Refresh" item above; this is a full renderer reload,
          // not a data refresh, and stays development-only.
          { role: "reload", accelerator: "CommandOrControl+Shift+R" },
          { role: "toggleDevTools" },
          { type: "separator" },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: viewItems,
  };
  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { role: "front" },
    ],
  };

  return platform === "darwin"
    ? [applicationMenu, editMenu, viewMenu, windowMenu]
    : [fileMenu, editMenu, viewMenu, windowMenu];
}
