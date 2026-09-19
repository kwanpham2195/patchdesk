import { describe, expect, it } from "vitest";

import { startDesktopBesideLoginShellImport } from "../../src/main/app-lifecycle";

/** A login shell that has not answered yet, and the handle that lets it. */
function pendingLoginShell() {
  let close = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return { run: () => closed, close };
}

describe("startup beside the login-shell import", () => {
  it("opens the workbench before the login shell closes", async () => {
    const shell = pendingLoginShell();
    const events: Array<string> = [];

    const { started, imported } = startDesktopBesideLoginShellImport(
      {
        async start() {
          events.push("workbench:show");
          return { _tag: "started" as const };
        },
      },
      shell.run,
    );

    await expect(started).resolves.toEqual({ _tag: "started" });
    expect(events).toEqual(["workbench:show"]);

    shell.close();
    await imported;
  });

  it("starts the import before the desktop, so every reader waits for that one import", async () => {
    const events: Array<string> = [];
    const { started, imported } = startDesktopBesideLoginShellImport(
      {
        async start() {
          events.push("desktop:start");
          return { _tag: "started" as const };
        },
      },
      async () => {
        events.push("login-shell:start");
      },
    );

    await started;
    await imported;

    expect(events).toEqual(["login-shell:start", "desktop:start"]);
  });
});
