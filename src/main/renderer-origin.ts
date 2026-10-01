export interface RendererSource {
  /** The development server URL to load; undefined loads the bundled renderer. */
  readonly url: string | undefined;
  /** The renderer origin, or the fail-closed opaque origin. */
  readonly origin: string;
}

/**
 * Decides where the workbench window loads from. A packaged app ignores
 * `ELECTRON_RENDERER_URL`, so a launch environment cannot give a remote page
 * the preload bridge.
 */
export function rendererSource(
  environment: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): RendererSource {
  const url = isPackaged ? undefined : environment.ELECTRON_RENDERER_URL;
  if (url === undefined || !URL.canParse(url)) return { url, origin: "null" };
  return { url, origin: new URL(url).origin };
}
