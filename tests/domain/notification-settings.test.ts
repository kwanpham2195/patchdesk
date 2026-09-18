import { describe, expect, it } from "vitest";

import {
  notificationSettingsOf,
  parsePatchdeskConfig,
  parsePatchdeskSettingsPatch,
} from "../../src/domain/contracts";

describe("notification settings", () => {
  it("defaults to notifications on and preparation and merge off when the config names none", () => {
    expect(notificationSettingsOf({})).toEqual({
      enabled: true,
      preparationAndMerge: false,
      intervalMinutes: 3,
    });
  });

  it("accepts a patch that sets both toggles and reads them back from the config", () => {
    const notifications = {
      enabled: false,
      preparationAndMerge: true,
      intervalMinutes: 3,
    };

    expect(parsePatchdeskSettingsPatch({ notifications })).toEqual({
      _tag: "ok",
      value: { notifications },
    });
    const config = parsePatchdeskConfig({ notifications });
    expect(
      config._tag === "ok" && notificationSettingsOf(config.value),
    ).toEqual(notifications);
  });

  it("reads a stored config that predates the poll interval with the default interval", () => {
    const config = parsePatchdeskConfig({
      notifications: { enabled: false, preparationAndMerge: true },
    });

    expect(
      config._tag === "ok" && notificationSettingsOf(config.value),
    ).toEqual({
      enabled: false,
      preparationAndMerge: true,
      intervalMinutes: 3,
    });
  });

  it.each([
    { notifications: { enabled: false, preparationAndMerge: true } },
    {
      notifications: {
        enabled: false,
        preparationAndMerge: true,
        intervalMinutes: 2,
      },
    },
    { notifications: { enabled: false } },
    {
      notifications: { enabled: false, preparationAndMerge: true, sound: true },
    },
    {
      notifications: {
        enabled: "no",
        preparationAndMerge: false,
        intervalMinutes: 3,
      },
    },
  ])("refuses the partial or unknown notifications patch %o", (patch) => {
    expect(parsePatchdeskSettingsPatch(patch)._tag).toBe("err");
  });
});
