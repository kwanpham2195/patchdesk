// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useInsightConfiguration } from "../../src/renderer/src/hooks/use-insight-configuration";
import {
  failure,
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
  it("drops a closed dialog's model activation without poisoning the next request", async () => {
    let settleFirst:
      | ((response: ReturnType<typeof failure>) => void)
      | undefined;
    let activation = 0;
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success({ providers: [], models: [] }),
      "/v1/insight-providers/codex/models": () => {
        activation += 1;
        if (activation === 1)
          return new Promise((resolve) => {
            settleFirst = resolve;
          });
        return success({
          providers: [],
          models: [
            {
              provider: "codex-cli-account",
              id: "current",
              label: "Current",
              reasoning: ["medium"],
            },
          ],
        });
      },
    });
    const { result } = renderHook(() =>
      useInsightConfiguration({
        profileId: "profile",
        initialInsight: "brief",
        selectedInsight: "brief",
      }),
    );
    await waitFor(() =>
      expect(result.current.configuration.catalog).toBeDefined(),
    );

    act(() => result.current.activateCodex());
    await waitFor(() =>
      expect(result.current.configuration.codexActivationPending).toBe(true),
    );
    act(() => result.current.cancelCodexActivation());
    expect(result.current.configuration.codexActivationPending).toBe(false);
    act(() => result.current.activateCodex());
    await waitFor(() =>
      expect(result.current.configuration.model).toBe("current"),
    );
    await act(async () => {
      settleFirst?.(failure({ error: "cancelled" }, 400));
    });

    expect(result.current.configuration).toMatchObject({
      model: "current",
      codexActivationPending: false,
      codexActivationError: false,
    });
  });

  it("suppresses a current cancellation but reports a genuine runtime failure", async () => {
    let response = failure({ error: "cancelled" }, 400);
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success({ providers: [], models: [] }),
      "/v1/insight-providers/codex/models": () => response,
    });
    const { result } = renderHook(() =>
      useInsightConfiguration({
        profileId: "profile",
        initialInsight: "brief",
        selectedInsight: "brief",
      }),
    );
    await waitFor(() =>
      expect(result.current.configuration.catalog).toBeDefined(),
    );

    act(() => result.current.activateCodex());
    await waitFor(() =>
      expect(result.current.configuration.codexActivationPending).toBe(false),
    );
    expect(result.current.configuration.codexActivationError).toBe(false);

    response = failure({ error: "runtime_unavailable" });
    act(() => result.current.activateCodex());
    await waitFor(() =>
      expect(result.current.configuration.codexActivationError).toBe(true),
    );
  });

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
        initialInsight: "brief",
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
