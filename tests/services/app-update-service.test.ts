import { describe, expect, it } from "vitest";

import { fetchLatestPatchdeskRelease } from "../../src/adapters/github/github-latest-release";
import type { AppUpdateRecord } from "../../src/adapters/storage/app-update-state-store";
import type { AppUpdateState } from "../../src/domain/app-update";
import { AppUpdateService } from "../../src/services/app-update-service";

const logPath = "/Users/someone/.local/share/patchdesk/logs/update.log";

function releaseResponse(tag: string): Response {
  return Response.json({
    tag_name: tag,
    html_url: `https://github.com/kwanpham2195/patchdesk/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
  });
}

/** One app launch over a shared record, a scripted GitHub, and a recorded helper. */
function launch(input: {
  readonly runningVersion: string;
  readonly record: { current: AppUpdateRecord };
  readonly respond?: () => Response;
  readonly checkEnabled?: boolean;
  readonly homebrew?: boolean;
  readonly executablePath?: string | undefined;
  readonly helperStarts?: boolean;
}) {
  const requests: string[] = [];
  const published: AppUpdateState[] = [];
  const warnings: string[] = [];
  const helperStarts: string[] = [];
  const service = new AppUpdateService({
    runningVersion: input.runningVersion,
    store: {
      load: async () => input.record.current,
      save: async (record) => {
        input.record.current = record;
        return true;
      },
    },
    checkEnabled: async () => input.checkEnabled ?? true,
    fetchLatestRelease: () =>
      fetchLatestPatchdeskRelease(async (url) => {
        requests.push(url);
        return (input.respond ?? (() => releaseResponse("v0.0.1")))();
      }),
    homebrewBrewPath:
      input.homebrew === false ? undefined : "/opt/homebrew/bin/brew",
    executablePath:
      input.executablePath ??
      "/Applications/Patchdesk.app/Contents/MacOS/Patchdesk",
    logPath,
    startHelper: async (brewPath) => {
      helperStarts.push(brewPath);
      return input.helperStarts ?? true;
    },
    publish: (state) => published.push(state),
    warn: (failure) => warnings.push(failure.reason),
  });
  return {
    service,
    requests,
    warnings,
    helperStarts,
    latest: () => published.at(-1),
  };
}

describe("AppUpdateService", () => {
  it("offers a newer release, keeps a dismissed one hidden across launches, and offers a later one again", async () => {
    const record = { current: {} };
    let tag = "v0.0.18";
    const first = launch({
      runningVersion: "0.0.17",
      record,
      respond: () => releaseResponse(tag),
    });
    await first.service.recordLaunch();
    await first.service.check();
    expect(first.latest()?.available).toMatchObject({
      version: "0.0.18",
      releaseUrl:
        "https://github.com/kwanpham2195/patchdesk/releases/tag/v0.0.18",
      install: "homebrew",
    });

    await first.service.dismissAvailable();
    expect(first.latest()?.available).toBeUndefined();

    const second = launch({
      runningVersion: "0.0.17",
      record,
      respond: () => releaseResponse(tag),
    });
    await second.service.recordLaunch();
    await second.service.check();
    expect(second.service.state().available).toBeUndefined();

    tag = "v0.0.19";
    await second.service.check();
    expect(second.latest()?.available?.version).toBe("0.0.19");
  });

  it("sends no request while Check for updates is off", async () => {
    const app = launch({
      runningVersion: "0.0.17",
      record: { current: {} },
      checkEnabled: false,
    });

    await app.service.check();

    expect(app.requests).toEqual([]);
    expect(app.service.state().available).toBeUndefined();
  });

  it("shows nothing and warns once however many checks fail", async () => {
    const app = launch({
      runningVersion: "0.0.17",
      record: { current: {} },
      respond: () => new Response("rate limited", { status: 403 }),
    });

    await app.service.check();
    await app.service.check();

    expect(app.requests).toHaveLength(2);
    expect(app.warnings).toHaveLength(1);
    expect(app.service.state().available).toBeUndefined();
  });

  it("starts the helper only for an install the close guard let through", async () => {
    const record = { current: {} };
    const app = launch({
      runningVersion: "0.0.17",
      record,
      respond: () => releaseResponse("v0.0.18"),
    });
    await app.service.recordLaunch();
    await app.service.check();

    expect(app.service.prepareInstall()).toBe(true);
    expect(app.latest()?.available?.installing).toBe(true);
    app.service.cancelInstall();
    expect(app.latest()?.available?.installing).toBe(false);
    await app.service.startInstallBeforeExit();
    expect(app.helperStarts).toEqual([]);

    app.service.prepareInstall();
    await app.service.startInstallBeforeExit();
    expect(app.helperStarts).toEqual(["/opt/homebrew/bin/brew"]);
    expect(record.current).toMatchObject({ updateAttemptedFrom: "0.0.17" });
  });

  it.each([
    {
      name: "without the Homebrew cask",
      homebrew: false,
      executablePath: undefined,
    },
    {
      name: "for a copy outside /Applications",
      homebrew: true,
      executablePath:
        "/Volumes/Patchdesk/Patchdesk.app/Contents/MacOS/Patchdesk",
    },
  ])("offers no install $name", async ({ homebrew, executablePath }) => {
    const app = launch({
      runningVersion: "0.0.17",
      record: { current: {} },
      respond: () => releaseResponse("v0.0.18"),
      homebrew,
      executablePath,
    });
    await app.service.check();

    expect(app.latest()?.available?.install).toBe("manual");
    expect(app.service.prepareInstall()).toBe(false);
  });

  it("records no attempt when the helper does not start", async () => {
    const record = { current: {} };
    const app = launch({
      runningVersion: "0.0.17",
      record,
      respond: () => releaseResponse("v0.0.18"),
      helperStarts: false,
    });
    await app.service.recordLaunch();
    await app.service.check();

    app.service.prepareInstall();
    await app.service.startInstallBeforeExit();

    expect(app.helperStarts).toEqual(["/opt/homebrew/bin/brew"]);
    expect(record.current).not.toHaveProperty("updateAttemptedFrom");
  });

  it.each([
    {
      name: "Updated to the new version after the version changed",
      record: { lastLaunchedVersion: "0.0.17", updateAttemptedFrom: "0.0.17" },
      runningVersion: "0.0.18",
      want: { kind: "updated", version: "0.0.18" },
    },
    {
      name: "a failed update when an attempt left the version unchanged",
      record: { lastLaunchedVersion: "0.0.17", updateAttemptedFrom: "0.0.17" },
      runningVersion: "0.0.17",
      want: { kind: "updateFailed", logPath },
    },
    {
      name: "nothing on an ordinary launch",
      record: { lastLaunchedVersion: "0.0.17" },
      runningVersion: "0.0.17",
      want: undefined,
    },
  ])("reports $name, once", async ({ record, runningVersion, want }) => {
    const shared = { current: record };
    const first = launch({ runningVersion, record: shared });
    await first.service.recordLaunch();
    expect(first.service.state().launchNotice).toEqual(want);

    const second = launch({ runningVersion, record: shared });
    await second.service.recordLaunch();
    expect(second.service.state().launchNotice).toBeUndefined();
  });
});
