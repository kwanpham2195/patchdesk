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

    act(() => result.current.activateAccount("codex-cli-account"));
    await waitFor(() =>
      expect(result.current.configuration.accountModelsPending).toBe(
        "codex-cli-account",
      ),
    );
    act(() => result.current.cancelAccountModels());
    expect(result.current.configuration.accountModelsPending).toBeNull();
    act(() => result.current.activateAccount("codex-cli-account"));
    await waitFor(() =>
      expect(result.current.configuration.model).toBe("current"),
    );
    await act(async () => {
      settleFirst?.(failure({ error: "cancelled" }, 400));
    });

    expect(result.current.configuration).toMatchObject({
      model: "current",
      accountModelsPending: null,
      accountModelsFailure: null,
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

    act(() => result.current.activateAccount("codex-cli-account"));
    await waitFor(() =>
      expect(result.current.configuration.accountModelsPending).toBeNull(),
    );
    expect(result.current.configuration.accountModelsFailure).toBeNull();

    response = failure({ error: "runtime_unavailable" });
    act(() => result.current.activateAccount("codex-cli-account"));
    await waitFor(() =>
      expect(result.current.configuration.accountModelsFailure).toEqual({
        provider: "codex-cli-account",
      }),
    );
  });

  it("loads pi CLI account models from their own route and keeps an outdated pi's required version", async () => {
    let response: ReturnType<typeof failure> | ReturnType<typeof success> =
      failure({ error: "runtime_unavailable", requiredVersion: "0.80.4" }, 503);
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success({ providers: [], models: [] }),
      "/v1/insight-providers/pi-cli/models": () => response,
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

    act(() => result.current.activateAccount("pi-cli-account"));
    await waitFor(() =>
      expect(result.current.configuration.accountModelsFailure).toEqual({
        provider: "pi-cli-account",
        requiredVersion: "0.80.4",
      }),
    );

    response = success({
      providers: [],
      models: [
        {
          provider: "pi-cli-account",
          id: "anthropic/claude-sonnet-5",
          label: "anthropic/claude-sonnet-5",
          reasoning: ["low", "medium", "high"],
          defaultReasoning: "medium",
        },
      ],
    });
    act(() => result.current.activateAccount("pi-cli-account"));
    await waitFor(() =>
      expect(result.current.configuration).toMatchObject({
        provider: "pi-cli-account",
        model: "anthropic/claude-sonnet-5",
        reasoning: "medium",
        accountModelsFailure: null,
      }),
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
