import type { BrowserWindowConstructorOptions } from "electron";

/**
 * The rendered height of the renderer's own titlebar (`.app-titlebar` in
 * `src/renderer/src/styles.css`). The two must stay in step: the traffic
 * lights are placed against this number, so changing one without the other
 * leaves them off-centre.
 */
export const workbenchTitlebarHeight = 48;

/** A macOS window button is 12px tall; three of them end around x = 70. */
const trafficLightHeight = 12;
const trafficLightInset = 18;

/**
 * macOS chrome for the workbench window. Patchdesk draws its own titlebar, so
 * the native bar would stack a second, redundant bar above it — `hiddenInset`
 * removes the bar and leaves only the traffic lights, which are then centred
 * in the app's header. `.app-titlebar` reserves the matching left inset so the
 * brand never sits under the lights.
 */
export const workbenchWindowChrome = {
  titleBarStyle: "hiddenInset",
  trafficLightPosition: {
    x: trafficLightInset,
    y: (workbenchTitlebarHeight - trafficLightHeight) / 2,
  },
} as const satisfies Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition"
>;
