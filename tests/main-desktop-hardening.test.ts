import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createDesktopMenuTemplate } from "../src/main/desktop-menu";
import { resolveDesktopClose } from "../src/main/desktop-close-guard";
import {
  contentSecurityPolicy,
  installWebContentsSecurity,
  isAllowedExternalUrl,
  normalizeExternalHosts,
  openAllowedExternalUrl,
} from "../src/main/external-navigation";
import {
  workbenchTitlebarHeight,
  workbenchWindowChrome,
} from "../src/main/window-chrome";
import { clampWindowBounds } from "../src/main/window-state";
import { generatedPiAiCatalog } from "../src/adapters/pi/pi-ai-catalog.generated";
import { resolveInsightRuntime } from "../src/main/insight-runtime";

describe("desktop hardening", () => {
  it("allows clean close, confirms dirty drafts, and blocks pending writes", async () => {
    const confirmDiscard = vi.fn(async () => true);

    await expect(resolveDesktopClose("clear", confirmDiscard)).resolves.toBe(
      "allow",
    );
    expect(confirmDiscard).not.toHaveBeenCalled();

    await expect(
      resolveDesktopClose("dirty_draft", confirmDiscard),
    ).resolves.toBe("allow");
    expect(confirmDiscard).toHaveBeenCalledOnce();

    confirmDiscard.mockResolvedValueOnce(false);
    await expect(
      resolveDesktopClose("dirty_draft", confirmDiscard),
    ).resolves.toBe("prevent");

    await expect(
      resolveDesktopClose("write_pending", confirmDiscard),
    ).resolves.toBe("prevent");
    expect(confirmDiscard).toHaveBeenCalledTimes(2);
  });

  it("opens only exact allowlisted HTTPS hosts without embedded credentials", async () => {
    const allowed = normalizeExternalHosts(["github.com", "git.cfw.example"]);
    const openExternal = vi.fn(async () => undefined);

    await expect(
      openAllowedExternalUrl(
        "https://github.com/centraldigital/patchdesk/pull/42",
        allowed,
        openExternal,
      ),
    ).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledOnce();

    for (const url of [
      "http://github.com/centraldigital/patchdesk",
      "https://github.com.evil.example/centraldigital/patchdesk",
      "https://user:password@github.com/centraldigital/patchdesk",
      "https://github.com:8443/centraldigital/patchdesk",
      "javascript:alert(1)",
      "file:///tmp/review.html",
    ]) {
      expect(isAllowedExternalUrl(url, allowed)).toBe(false);
    }
  });

  it("uses native macOS application roles and keeps developer roles out of production", () => {
    const noActions = {
      openSettings: () => undefined,
      refresh: () => undefined,
    };
    const production = createDesktopMenuTemplate(
      "darwin",
      "Patchdesk",
      false,
      noActions,
    );
    const development = createDesktopMenuTemplate(
      "darwin",
      "Patchdesk",
      true,
      noActions,
    );

    expect(production[0]).toMatchObject({ label: "Patchdesk" });
    expect(JSON.stringify(production)).toContain('"role":"about"');
    expect(JSON.stringify(production)).toContain('"role":"quit"');
    expect(JSON.stringify(production)).not.toContain('"role":"toggleDevTools"');
    expect(JSON.stringify(development)).toContain('"role":"toggleDevTools"');
    expect(JSON.stringify(production)).toContain('"label":"Settings…"');
    expect(JSON.stringify(production)).toContain(
      '"accelerator":"CommandOrControl+,"',
    );
  });

  it("denies in-app navigation, popups, permissions, redirects, and downloads", async () => {
    const listeners = new Map<string, (...input: never[]) => void>();
    const sessionListeners = new Map<string, (...input: never[]) => void>();
    const setPermissionCheckHandler = vi.fn();
    const setPermissionRequestHandler = vi.fn();
    const setWindowOpenHandler = vi.fn();
    const openExternal = vi.fn(async () => undefined);
    const webContents = {
      setWindowOpenHandler,
      on: vi.fn((event: string, listener: (...input: never[]) => void) => {
        listeners.set(event, listener);
      }),
      session: {
        setPermissionCheckHandler,
        setPermissionRequestHandler,
        on: vi.fn((event: string, listener: (...input: never[]) => void) => {
          sessionListeners.set(event, listener);
        }),
        webRequest: { onHeadersReceived: vi.fn() },
      },
    };

    installWebContentsSecurity(
      webContents,
      normalizeExternalHosts(["github.com"]),
      openExternal,
    );

    // SAFETY: installWebContentsSecurity above registers exactly one
    // setWindowOpenHandler callback, shaped like GuardedWebContents's
    // `(details: { readonly url: string }) => { readonly action: "deny" }`;
    // the untyped `vi.fn()` mock erases that shape, so this recovers it to
    // call the handler directly.
    const popup = setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
      readonly url: string;
    }) => { readonly action: string };
    expect(popup({ url: "https://github.com/org/repo" })).toEqual({
      action: "deny",
    });
    expect(popup({ url: "https://evil.example" })).toEqual({ action: "deny" });

    const navigationEvent = { preventDefault: vi.fn() };
    // SAFETY: the `on` mock above stores installWebContentsSecurity's real
    // "will-navigate" listener — a `(event, url: string) => void` per
    // GuardedWebContents — under this key; the map's `never[]` rest type only
    // exists so one Map can hold every event's listener signature, so casting
    // these two real call arguments back to it here is safe.
    listeners.get("will-navigate")?.(
      navigationEvent as never,
      "https://github.com/org/repo" as never,
    );
    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce();
    const redirectEvent = { preventDefault: vi.fn() };
    // SAFETY: same invariant as "will-navigate" above; installWebContentsSecurity
    // registers a `(event) => void` "will-redirect" listener under this key.
    listeners.get("will-redirect")?.(redirectEvent as never);
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();

    const downloadEvent = { preventDefault: vi.fn() };
    // SAFETY: same invariant as above; installWebContentsSecurity registers a
    // `(event) => void` "will-download" listener on the session mock under
    // this key.
    sessionListeners.get("will-download")?.(downloadEvent as never);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    expect(setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(setPermissionRequestHandler).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
  });

  it("allows only the app's own origin to write the clipboard, and denies every other permission", () => {
    const setPermissionCheckHandler = vi.fn();
    const setPermissionRequestHandler = vi.fn();
    const webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: {
        setPermissionCheckHandler,
        setPermissionRequestHandler,
        on: vi.fn(),
        webRequest: { onHeadersReceived: vi.fn() },
      },
    };
    const ownOrigin = "http://localhost:5173";

    installWebContentsSecurity(
      webContents,
      normalizeExternalHosts(["github.com"]),
      async () => undefined,
      false,
      ownOrigin,
    );

    // SAFETY: same invariant as the mock recovery above -- installWebContentsSecurity
    // registers exactly one `(webContents, permission, requestingOrigin) => boolean`
    // check handler.
    const checkHandler = setPermissionCheckHandler.mock.calls[0]?.[0] as (
      webContents: null,
      permission: string,
      requestingOrigin: string,
    ) => boolean;
    expect(checkHandler(null, "clipboard-sanitized-write", ownOrigin)).toBe(
      true,
    );
    expect(
      checkHandler(null, "clipboard-sanitized-write", "http://evil.example"),
    ).toBe(false);
    expect(checkHandler(null, "clipboard-read", ownOrigin)).toBe(false);
    expect(checkHandler(null, "notifications", ownOrigin)).toBe(false);
    expect(checkHandler(null, "media", ownOrigin)).toBe(false);

    // SAFETY: same invariant -- installWebContentsSecurity registers exactly
    // one `(webContents, permission, callback, details) => void` request
    // handler.
    const requestHandler = setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: null,
      permission: string,
      callback: (granted: boolean) => void,
      details: { requestingUrl?: string },
    ) => void;
    const grants: boolean[] = [];
    const callback = (granted: boolean) => grants.push(granted);
    requestHandler(null, "clipboard-sanitized-write", callback, {
      requestingUrl: `${ownOrigin}/reader`,
    });
    requestHandler(null, "clipboard-sanitized-write", callback, {
      requestingUrl: "http://evil.example/reader",
    });
    requestHandler(null, "clipboard-read", callback, {
      requestingUrl: `${ownOrigin}/reader`,
    });
    requestHandler(null, "notifications", callback, {
      requestingUrl: `${ownOrigin}/reader`,
    });
    requestHandler(null, "media", callback, {
      requestingUrl: `${ownOrigin}/reader`,
    });
    expect(grants).toEqual([true, false, false, false, false]);
  });

  it("uses a File menu on non-macOS platforms", () => {
    expect(
      createDesktopMenuTemplate("linux", "Patchdesk", false, {
        openSettings: () => undefined,
        refresh: () => undefined,
      })[0],
    ).toMatchObject({
      label: "File",
    });
  });

  it("keeps development origins out of the packaged content security policy", () => {
    expect(contentSecurityPolicy(true)).not.toContain("localhost:5173");
    expect(contentSecurityPolicy(false)).toContain("ws://localhost:5173");
  });

  it("allows Vite's development bootstrap without weakening packaged scripts", () => {
    expect(contentSecurityPolicy(false)).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(contentSecurityPolicy(true)).toContain(
      "script-src 'self' 'wasm-unsafe-eval';",
    );
  });

  it("allows WebAssembly so the diff highlighter can start, without allowing eval", () => {
    for (const packaged of [true, false]) {
      const scriptSource = /script-src ([^;]+);/u.exec(
        contentSecurityPolicy(packaged),
      )?.[1];
      expect(scriptSource).toContain("'wasm-unsafe-eval'");
      expect(scriptSource).not.toContain("'unsafe-eval'");
    }
  });

  it("restores window geometry onto an available display at a usable size", () => {
    const laptop = { x: 0, y: 0, width: 1440, height: 900 };
    const external = { x: 1440, y: -120, width: 1920, height: 1080 };

    expect(
      clampWindowBounds({ x: 1600, y: 20, width: 1200, height: 800 }, [
        laptop,
        external,
      ]),
    ).toEqual({ x: 1600, y: 20, width: 1200, height: 800 });
    expect(
      clampWindowBounds({ x: 4000, y: 2000, width: 300, height: 200 }, [
        laptop,
      ]),
    ).toEqual({ x: 480, y: 260, width: 960, height: 640 });
    expect(
      clampWindowBounds({ x: -200, y: -100, width: 3000, height: 2000 }, [
        { x: 0, y: 0, width: 800, height: 600 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("hides the native title bar and centres the traffic lights in the app header", () => {
    expect(workbenchWindowChrome.titleBarStyle).toBe("hiddenInset");
    expect(workbenchWindowChrome.trafficLightPosition).toEqual({
      x: 18,
      y: 18,
    });
    // A 12px-tall light is centred only when the space above and below match.
    const light = 12;
    expect(workbenchWindowChrome.trafficLightPosition.y * 2 + light).toBe(
      workbenchTitlebarHeight,
    );
  });

  it("prefers a packaged one-shot runtime with an exact manifest and lock digest", () => {
    const packagedRoot =
      "/Applications/Patchdesk.app/Contents/Resources/flue-runtime";
    const lock = "lockfileVersion: '6.0'\n";
    // SAFETY: pi-ai-catalog.generated.ts's literal always carries a top-level
    // `digest: string` field (see the file's last property), even though its
    // export is deliberately typed `unknown`; this narrows just that field.
    const catalogDigest = (generatedPiAiCatalog as { readonly digest: string })
      .digest;
    const files = new Map<string, string>([
      [`${packagedRoot}/patchdesk-insight-runner.js`, ""],
      [`${packagedRoot}/pnpm-lock.yaml`, lock],
      [
        `${packagedRoot}/runtime-manifest.json`,
        JSON.stringify({
          piVersion: "0.84.4",
          catalogDigest,
          nodeFloor: ">=22.19.0",
          lockDigest: createHash("sha256").update(lock).digest("hex"),
        }),
      ],
    ]);

    expect(
      resolveInsightRuntime(
        "/Applications/Patchdesk.app/Contents/Resources/app.asar",
        "/workspace/patchdesk",
        true,
        (path) => files.has(path),
        (path) => files.get(path) ?? "",
      ),
    ).toEqual({
      kind: "packaged",
      root: packagedRoot,
      runnerPath: `${packagedRoot}/patchdesk-insight-runner.js`,
      manifestPath: `${packagedRoot}/runtime-manifest.json`,
    });

    files.set(
      `${packagedRoot}/runtime-manifest.json`,
      JSON.stringify({
        piVersion: "0.84.3",
        catalogDigest,
        nodeFloor: ">=22.19.0",
        lockDigest: createHash("sha256").update(lock).digest("hex"),
      }),
    );
    expect(
      resolveInsightRuntime(
        "/Applications/Patchdesk.app/Contents/Resources/app.asar",
        "/workspace/patchdesk",
        true,
        (path) => files.has(path),
        (path) => files.get(path) ?? "",
      ),
    ).toBeUndefined();
  });

  it("prefers the development build over a staged one only when unpackaged", () => {
    const cwd = "/workspace/patchdesk";
    const stagedRoot = `${cwd}/out/workflow-runtime`;
    const developmentRoot = `${cwd}/runtime/flue`;
    const lock = "lockfileVersion: '6.0'\n";
    // SAFETY: as above -- the generated catalog literal always carries `digest`.
    const catalogDigest = (generatedPiAiCatalog as { readonly digest: string })
      .digest;
    // Both roots pass every manifest check: the manifest pins the Pi version,
    // the catalog digest, the node floor and the lock digest, so a staging
    // built before a request type existed is indistinguishable from a fresh
    // one. Only the resolution order keeps the stale runner out of a
    // `pnpm dev` run, which rebuilds `runtime/flue/dist` on every start.
    const manifest = JSON.stringify({
      piVersion: "0.84.4",
      catalogDigest,
      nodeFloor: ">=22.19.0",
      lockDigest: createHash("sha256").update(lock).digest("hex"),
    });
    const files = new Map<string, string>([
      [`${stagedRoot}/patchdesk-insight-runner.js`, ""],
      [`${stagedRoot}/pnpm-lock.yaml`, lock],
      [`${stagedRoot}/runtime-manifest.json`, manifest],
      [`${developmentRoot}/dist/patchdesk-insight-runner.js`, ""],
      [`${developmentRoot}/pnpm-lock.yaml`, lock],
      [`${developmentRoot}/runtime-manifest.json`, manifest],
    ]);
    const resolve = (isPackaged: boolean) =>
      resolveInsightRuntime(
        `${cwd}/out/main/index.js`,
        cwd,
        isPackaged,
        (path) => files.has(path),
        (path) => files.get(path) ?? "",
      );

    expect(resolve(false)).toEqual({
      kind: "development",
      root: developmentRoot,
      runnerPath: `${developmentRoot}/dist/patchdesk-insight-runner.js`,
      manifestPath: `${developmentRoot}/runtime-manifest.json`,
    });
    expect(resolve(true)).toEqual({
      kind: "staged",
      root: stagedRoot,
      runnerPath: `${stagedRoot}/patchdesk-insight-runner.js`,
      manifestPath: `${stagedRoot}/runtime-manifest.json`,
    });
  });
});
