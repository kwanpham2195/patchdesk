import { ipcMain, type BrowserWindow } from "electron";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import {
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "#src/domain/ids";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { isPathContained } from "#src/adapters/storage/path-containment";
import { readOwnedParents } from "#src/adapters/storage/insight-artifact-files";
import { patchCaptureFailure } from "#src/adapters/storage/insight-artifact-job-protocol";
import { InsightPatchCaptureService } from "#src/services/insight-patch-capture-service";
import type { InsightResourceBundle } from "#src/services/insight-resource-bundle";
import type { ReviewOperationCoordinator } from "#src/services/review-operation-coordinator";
import {
  INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL,
  insightCaptureDiagnosticRequestSchema,
  type InsightCaptureDiagnosticRequest,
  type InsightCaptureDiagnosticReply,
} from "./insight-capture-diagnostics-channel";

/** Owns a single explicit, disposable patch-staging diagnostic, not the user Start or CaptureRoot pipeline. */
export type InsightCaptureDiagnostics = {
  /** Binds the current window's main-frame identity and expected development renderer origin. */
  install(window: BrowserWindow, origin: string): void;
  /** Terminally closes admission, aborts and joins its sole task; repeated calls join the same cleanup. */
  dispose(): Promise<void>;
};

/** Reads opt-in and exact selected identity once at composition; does no filesystem work until stage. */
export function createInsightCaptureDiagnostics(
  paths: PatchdeskPaths,
  resources: InsightResourceBundle,
  operations: ReviewOperationCoordinator,
  packaged: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): InsightCaptureDiagnostics | undefined {
  if (
    packaged ||
    environment.PATCHDESK_INSIGHT_PATCH_CAPTURE !== "1" ||
    environment.PATCHDESK_DEV_SHARED === "1"
  )
    return undefined;
  const profileId = parseWorkspaceProfileId(
    environment.PATCHDESK_INSIGHT_PATCH_PROFILE ?? "",
  );
  const reviewId = parseReviewId(
    environment.PATCHDESK_INSIGHT_PATCH_REVIEW ?? "",
  );
  if (profileId._tag === "err" || reviewId._tag === "err") return undefined;
  const selectedProfile = profileId.value;
  const selectedReview = reviewId.value;
  const service = new InsightPatchCaptureService(paths, resources, operations);
  let closed = false;
  let task: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let operation:
    | {
        readonly request: InsightCaptureDiagnosticRequest;
        readonly controller: AbortController;
        reply: InsightCaptureDiagnosticReply;
      }
    | undefined;

  async function stage(
    request: InsightCaptureDiagnosticRequest,
    controller: AbortController,
  ): Promise<InsightCaptureDiagnosticReply> {
    const sessionId = parseReviewSessionId(request.sessionId);
    if (sessionId._tag === "err")
      return { status: "rejected", reason: "invalid_request" };
    try {
      const installed = PatchdeskPaths.fromEnvironment({});
      const sourceRoots = [
        paths.dataDirectory(),
        paths.configDirectory(),
        paths.cacheDirectory(),
      ];
      const installedRoots = [
        installed.dataDirectory(),
        installed.configDirectory(),
        installed.cacheDirectory(),
      ];
      for (const source of sourceRoots) {
        const physical = await realpath(source);
        for (const root of installedRoots) {
          const installedPhysical = await realpath(root);
          if (
            isPathContained(installedPhysical, physical) ||
            isPathContained(physical, installedPhysical)
          )
            return {
              status: "settled",
              result: patchCaptureFailure("invalid_source"),
            };
        }
      }
      const cache = await realpath(paths.cacheDirectory());
      const owned = await readOwnedParents(
        cache,
        join(cache, ".diagnostic-check"),
      );
      if (owned._tag === "err" || controller.signal.aborted)
        return {
          status: "settled",
          result: patchCaptureFailure(
            controller.signal.aborted ? "aborted" : "invalid_source",
          ),
        };
      const scope = await mkdtemp(join(cache, "insight-patch-diagnostic-"));
      if (!isPathContained(cache, await realpath(scope)))
        return {
          status: "settled",
          result: patchCaptureFailure("invalid_source"),
        };
      for (const source of [paths.dataDirectory(), paths.configDirectory()]) {
        const physical = await realpath(source);
        if (
          isPathContained(physical, scope) ||
          isPathContained(scope, physical)
        )
          return {
            status: "settled",
            result: patchCaptureFailure("invalid_source"),
          };
      }
      const destination = PatchdeskPaths.fromEnvironment({
        PATCHDESK_DATA_DIRECTORY: scope,
        PATCHDESK_CONFIG_DIRECTORY: scope,
        PATCHDESK_CACHE_DIRECTORY: scope,
      });
      await mkdir(
        destination.reviewDirectory(selectedProfile, selectedReview),
        { recursive: true, mode: 0o700 },
      );
      const result = await service.stage(
        selectedProfile,
        selectedReview,
        request.revision,
        sessionId.value,
        request.patchHash,
        destination,
        { signal: controller.signal },
      );
      return { status: "settled", result };
    } catch {
      return {
        status: "settled",
        result: patchCaptureFailure(
          controller.signal.aborted ? "aborted" : "io",
        ),
      };
    }
  }

  return {
    install(window, origin) {
      if (closed) return;
      ipcMain.removeHandler(INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL);
      ipcMain.handle(
        INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL,
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Electron IPC payloads enter untyped and are parsed before use.
        (event, input: unknown): InsightCaptureDiagnosticReply => {
          let senderOrigin: string;
          try {
            senderOrigin = new URL(event.senderFrame?.url ?? "").origin;
          } catch {
            return { status: "rejected", reason: "unauthorized" };
          }
          if (
            closed ||
            packaged ||
            window.isDestroyed() ||
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            origin === "null" ||
            senderOrigin !== origin
          )
            return { status: "rejected", reason: "unauthorized" };
          const parsed = v.safeParse(
            insightCaptureDiagnosticRequestSchema,
            input,
          );
          if (!parsed.success)
            return { status: "rejected", reason: "invalid_request" };
          const request = parsed.output;
          if (
            request.profileId !== selectedProfile ||
            request.reviewId !== selectedReview
          )
            return { status: "rejected", reason: "unauthorized" };
          if (operation !== undefined) {
            const original = operation.request;
            if (
              request.revision !== original.revision ||
              request.sessionId !== original.sessionId ||
              request.patchHash !== original.patchHash
            )
              return { status: "rejected", reason: "unauthorized" };
            if (request.action === "stage")
              return { status: "rejected", reason: "already_started" };
            if (
              request.action === "cancel" &&
              operation.reply.status !== "settled" &&
              operation.reply.status !== "rejected"
            ) {
              operation.controller.abort();
              operation.reply = { status: "cancelling" };
            }
            return operation.reply;
          }
          if (request.action !== "stage") return { status: "idle" };
          const current = {
            request,
            controller: new AbortController(),
            reply: {
              status: "running",
            } satisfies InsightCaptureDiagnosticReply,
          };
          operation = current;
          task = stage(request, current.controller).then((reply) => {
            if (!closed && operation !== undefined) operation.reply = reply;
          });
          return operation.reply;
        },
      );
    },
    dispose() {
      if (disposal !== undefined) return disposal;
      closed = true;
      ipcMain.removeHandler(INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL);
      operation?.controller.abort();
      disposal = (async () => {
        await task;
      })();
      return disposal;
    },
  };
}
