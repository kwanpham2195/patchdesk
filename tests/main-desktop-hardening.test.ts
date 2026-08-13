import { createHash } from "node:crypto";

import type { WebContents } from "electron";
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
    const production = createDesktopMenuTemplate("darwin", "Patchdesk", false);
    const development = createDesktopMenuTemplate("darwin", "Patchdesk", true);

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
    } as unknown as WebContents;

    installWebContentsSecurity(
      webContents,
      normalizeExternalHosts(["github.com"]),
      openExternal,
    );

    const popup = setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
      readonly url: string;
    }) => { readonly action: string };
    expect(popup({ url: "https://github.com/org/repo" })).toEqual({
      action: "deny",
    });
    expect(popup({ url: "https://evil.example" })).toEqual({ action: "deny" });

    const navigationEvent = { preventDefault: vi.fn() };
    listeners.get("will-navigate")?.(
      navigationEvent as never,
      "https://github.com/org/repo" as never,
    );
    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce();
    const redirectEvent = { preventDefault: vi.fn() };
    listeners.get("will-redirect")?.(redirectEvent as never);
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();

    const downloadEvent = { preventDefault: vi.fn() };
    sessionListeners.get("will-download")?.(downloadEvent as never);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    expect(setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(setPermissionRequestHandler).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
  });

  it("uses a File menu on non-macOS platforms", () => {
    expect(
      createDesktopMenuTemplate("linux", "Patchdesk", false)[0],
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
    expect(contentSecurityPolicy(true)).toContain("script-src 'self';");
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

  it("prefers a packaged one-shot runtime with an exact manifest and lock digest", () => {
    const packagedRoot =
      "/Applications/Patchdesk.app/Contents/Resources/flue-runtime";
    const lock = "lockfileVersion: '6.0'\n";
    const catalogDigest = (generatedPiAiCatalog as { readonly digest: string })
      .digest;
    const files = new Map<string, string>([
      [`${packagedRoot}/patchdesk-insight-runner.js`, ""],
      [`${packagedRoot}/pnpm-lock.yaml`, lock],
      [
        `${packagedRoot}/runtime-manifest.json`,
        JSON.stringify({
          flueVersion: "2.0.3",
          piVersion: "0.84.1",
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
        (path) => files.has(path),
        (path) => files.get(path) ?? "",
      ),
    ).toEqual({
      root: packagedRoot,
      runnerPath: `${packagedRoot}/patchdesk-insight-runner.js`,
      manifestPath: `${packagedRoot}/runtime-manifest.json`,
    });

    files.set(
      `${packagedRoot}/runtime-manifest.json`,
      JSON.stringify({
        flueVersion: "2.0.2",
        piVersion: "0.84.1",
        catalogDigest,
        nodeFloor: ">=22.19.0",
        lockDigest: createHash("sha256").update(lock).digest("hex"),
      }),
    );
    expect(
      resolveInsightRuntime(
        "/Applications/Patchdesk.app/Contents/Resources/app.asar",
        "/workspace/patchdesk",
        (path) => files.has(path),
        (path) => files.get(path) ?? "",
      ),
    ).toBeUndefined();
  });
});
