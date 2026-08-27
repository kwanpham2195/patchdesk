import type { Mock } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type {
  DesktopRequest,
  DesktopResponse,
  LocalApiDesktopRequest,
} from "../../src/main/ipc-contract";
import {
  installDesktopDouble,
  type DesktopDouble,
} from "./fake-desktop-response";

/**
 * Every loopback path `ReviewWorkbenchFlow` reaches for. The calling test's
 * own handler still decides what comes back; listing the paths is what keeps
 * the double strict — a request no test scripted throws, naming the path,
 * instead of being answered with a default nobody wrote.
 */
const WORKBENCH_PATHS = [
  "/v1/logs",
  "/v1/insight-providers",
  "/v1/insight-providers/codex/models",
  "/v1/reviews/load",
  "/v1/reviews/refresh",
  "/v1/reviews/detect-updates",
  "/v1/reviews/diff-file",
  "/v1/reviews/assignees",
  "/v1/reviews/reviewers",
  "/v1/reviews/merge",
  "/v1/reviews/merge/recover",
  "/v1/reviews/direct-summary/submit",
  "/v1/reviews/inline-conversations/command",
  "/v1/reviews/pending-review/command",
  "/v1/reviews/pending-review/recover",
] as const;

/**
 * Answers one workbench request. Each test shapes its own fixture payload, so
 * the return type is `unknown` rather than an unparsed I/O boundary value.
 */
export type WorkbenchBridgeHandler = (input: {
  readonly path: string;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above
  readonly body?: unknown;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above
}) => Promise<unknown> | unknown;

let installed: DesktopDouble | undefined;

/**
 * Installs the desktop double for a `ReviewWorkbenchFlow` test and returns its
 * `request` spy, so assertions can read the calls the flow actually made.
 */
export function bridge(
  handler: WorkbenchBridgeHandler,
): Mock<(input: DesktopRequest) => Promise<DesktopResponse>> {
  const route = async (
    input: LocalApiDesktopRequest,
  ): Promise<DesktopResponse> => ({
    ok: true,
    status: 200,
    correlationId: input.path,
    // SAFETY: every fixture body in these tests is JSON data; the handler's
    // return type is `unknown` only because each test shapes its own payload.
    body: (await handler(input)) as RawJsonValue | undefined,
  });
  installed = installDesktopDouble(
    Object.fromEntries(WORKBENCH_PATHS.map((path) => [path, route])),
  );
  return installed.request;
}

/** Removes the installed double. Call this in `afterEach`. */
export function restoreBridge(): void {
  installed?.restore();
  installed = undefined;
}
