import type { MenuItemConstructorOptions } from "electron";

/** Builds a native, role-based desktop menu without renderer privileges. */
export function createDesktopMenuTemplate(
  platform: NodeJS.Platform,
  applicationName: string,
  development: boolean,
  actions: { readonly openSettings?: () => void } = {},
): ReadonlyArray<MenuItemConstructorOptions> {
  const applicationMenu: MenuItemConstructorOptions = {
    label: applicationName,
    submenu: [
      { role: "about" },
      { type: "separator" },
      {
        label: "Settings…",
        accelerator: "CommandOrControl+,",
        ...(actions.openSettings === undefined
          ? {}
          : { click: actions.openSettings }),
      },
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
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      {
        label: "Settings…",
        accelerator: "CommandOrControl+,",
        ...(actions.openSettings === undefined
          ? {}
          : { click: actions.openSettings }),
      },
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
  const viewItems: MenuItemConstructorOptions[] = [
    ...(development
      ? ([
          { role: "reload" },
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
