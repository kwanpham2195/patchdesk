// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useProfileSwitch } from "../../src/renderer/src/hooks/use-profile-switch";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

describe("useProfileSwitch", () => {
  it("keeps the newer success when distinct profile responses settle in reverse order", async () => {
    const first = deferredDesktopResponse();
    const second = deferredDesktopResponse();
    const requests = [first.promise, second.promise];
    let requestIndex = 0;
    desktop = installDesktopDouble({
      "/v1/profiles/select": () => {
        const response = requests[requestIndex];
        requestIndex += 1;
        if (response === undefined)
          throw new Error("Unexpected profile selection request");
        return response;
      },
    });
    const applied: string[] = [];
    const { result } = renderHook(() =>
      useProfileSwitch(async (profileId) => {
        applied.push(profileId);
      }),
    );

    let selectA: Promise<string> | undefined;
    let selectB: Promise<string> | undefined;
    act(() => {
      selectA = result.current.switchProfile("a", "header");
      selectB = result.current.switchProfile("b", "header");
    });
    await act(async () => second.resolve(success({})));
    await expect(selectB).resolves.toBe("applied");
    expect(applied).toEqual(["b"]);

    await act(async () => first.resolve(failure({ error: "storage" })));
    await expect(selectA).resolves.toBe("obsolete");
    expect(applied).toEqual(["b"]);
    expect(result.current.profileSwitchState.error).toBeUndefined();
  });

  it("keeps the latest entry point's failure when an obsolete success settles later", async () => {
    const first = deferredDesktopResponse();
    const second = deferredDesktopResponse();
    const requests = [first.promise, second.promise];
    let requestIndex = 0;
    desktop = installDesktopDouble({
      "/v1/profiles/select": () => {
        const response = requests[requestIndex];
        requestIndex += 1;
        if (response === undefined)
          throw new Error("Unexpected profile selection request");
        return response;
      },
    });
    const applied: string[] = [];
    const { result } = renderHook(() =>
      useProfileSwitch(async (profileId) => {
        applied.push(profileId);
      }),
    );

    let selectA: Promise<string> | undefined;
    let selectB: Promise<string> | undefined;
    act(() => {
      selectA = result.current.switchProfile("a", "header");
      selectB = result.current.switchProfile("b", "settings");
    });
    expect(result.current.profileSwitchState.pendingOwner).toBe("settings");

    await act(async () => second.resolve(failure({ error: "storage" })));
    await expect(selectB).resolves.toBe("failed");
    expect(result.current.profileSwitchState.error).toEqual({
      owner: "settings",
      message: "Patchdesk could not save the local review state.",
    });

    await act(async () => first.resolve(success({})));
    await expect(selectA).resolves.toBe("obsolete");
    expect(applied).toEqual([]);
    expect(result.current.profileSwitchState.error?.owner).toBe("settings");
  });

  it("shares one request for duplicate targets while the latest caller owns settlement", async () => {
    const response = deferredDesktopResponse();
    let requestCount = 0;
    desktop = installDesktopDouble({
      "/v1/profiles/select": () => {
        requestCount += 1;
        return response.promise;
      },
    });
    const applied: string[] = [];
    const { result } = renderHook(() =>
      useProfileSwitch(async (profileId) => {
        applied.push(profileId);
      }),
    );

    let headerSelection: Promise<string> | undefined;
    let settingsSelection: Promise<string> | undefined;
    act(() => {
      headerSelection = result.current.switchProfile("shared", "header");
      settingsSelection = result.current.switchProfile("shared", "settings");
    });
    expect(requestCount).toBe(1);
    expect(result.current.profileSwitchState).toMatchObject({
      pendingTarget: "shared",
      pendingOwner: "settings",
    });

    await act(async () => response.resolve(success({})));
    await expect(headerSelection).resolves.toBe("obsolete");
    await expect(settingsSelection).resolves.toBe("applied");
    expect(applied).toEqual(["shared"]);
    expect(result.current.profileSwitchState.pendingTarget).toBeUndefined();
  });
});

type DesktopResponseFixture =
  | ReturnType<typeof success>
  | ReturnType<typeof failure>;

function deferredDesktopResponse() {
  let resolve: (value: DesktopResponseFixture) => void = () => undefined;
  return {
    promise: new Promise<DesktopResponseFixture>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
