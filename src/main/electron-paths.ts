import { join } from "node:path";

/** Resolves electron-vite's sibling preload output from the compiled main directory. */
export function preloadScriptPath(mainDirectory: string): string {
  return join(mainDirectory, "../preload/preload.js");
}
