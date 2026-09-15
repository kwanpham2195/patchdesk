// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useInsightConfiguration } from "../../src/renderer/src/hooks/use-insight-configuration";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

describe("useInsightConfiguration", () => {
  it("passes each Pi model's list price through to the run dialog options", async () => {
    desktop = installDesktopDouble({
      "/v1/insight-providers": () =>
        success({
          providers: [],
          models: [
            {
              provider: "pi",
              id: "amazon-bedrock/amazon.nova-micro-v1:0",
              label: "amazon-bedrock/amazon.nova-micro-v1:0",
              reasoning: ["low", "medium", "high"],
              cost: { input: 0.035, output: 0.14 },
            },
          ],
        }),
    });
    const { result } = renderHook(() =>
      useInsightConfiguration({
        profileId: "profile",
        initialDetail: undefined,
        selectedInsight: "brief",
      }),
    );
    await waitFor(() =>
      expect(result.current.configuration.models).toHaveLength(1),
    );
    expect(result.current.configuration.models[0]?.cost).toEqual({
      input: 0.035,
      output: 0.14,
    });
  });
});
