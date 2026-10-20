import { ipcMain, type BrowserWindow } from "electron";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { err, ok, type Result } from "#src/domain/result";
import { mapConcurrent } from "#src/domain/map-concurrent";
import {
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "#src/domain/ids";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { isPathContained } from "#src/adapters/storage/path-containment";
import { readOwnedParents } from "#src/adapters/storage/insight-artifact-files";
import {
  guidePreparationFailure,
  patchCaptureFailure,
} from "#src/adapters/storage/insight-artifact-job-protocol";
import {
  DIAGNOSTIC_SCOPE_PREFIX,
  discoverGuideScopes,
  registerGuideScope,
} from "#src/adapters/storage/guide-preparation-store";
import {
  GuidePreparationService,
  recoverGuideScope,
} from "#src/services/guide-preparation-service";
import { currentIsoTimestamp } from "#src/services/insight-run-coordinator";
import { InsightPatchCaptureService } from "#src/services/insight-patch-capture-service";
import type { InsightResourceBundle } from "#src/services/insight-resource-bundle";
import type { ReviewContextPackService } from "#src/services/review-context-pack-service";
import type { ReviewOperationCoordinator } from "#src/services/review-operation-coordinator";
import {
  INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL,
  insightCaptureDiagnosticRequestSchema,
  type InsightCaptureDiagnosticRequest,
  type InsightCaptureDiagnosticReply,
} from "./insight-capture-diagnostics-channel";

/** Owns a single explicit, disposable patch-staging or Guide-preparation diagnostic, not the user Start or CaptureRoot pipeline. */
export type InsightCaptureDiagnostics = {
  /** Supplies the app's context pack, built over its GitHub reader once that exists; Guide preparation is refused before. */
  connectContext(
    pack: Pick<ReviewContextPackService, "captureRunContext">,
  ): void;
  /** Binds the current window's main-frame identity and expected development renderer origin. */
  install(window: BrowserWindow, origin: string): void;
  /** Terminally closes admission, aborts and joins its sole task; repeated calls join the same cleanup. */
  dispose(): Promise<void>;
};

type Operation = {
  readonly request: InsightCaptureDiagnosticRequest;
  /** Records cancellation durably where the operation has durable state, then aborts its work; a failure is retryable. */
  cancel: () => Promise<Result<void, "unsettled">>;
  /** Only while a cancel is in flight: a finished cancel, successful or not, is not remembered. */
  cancelling?: Promise<Result<void, "unsettled">> | undefined;
  reply: InsightCaptureDiagnosticReply;
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
  let contextPack:
    | Pick<ReviewContextPackService, "captureRunContext">
    | undefined;
  let recovery: Promise<void> | undefined;
  let operation: Operation | undefined;

  /** A new directory in the cache that neither overlaps nor aliases any source or installed root. */
  async function createScope(
    controller: AbortController,
    register: boolean,
  ): Promise<Result<PatchdeskPaths, "aborted" | "invalid_source">> {
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
          return err("invalid_source");
      }
    }
    const cache = await realpath(paths.cacheDirectory());
    const owned = await readOwnedParents(
      cache,
      join(cache, ".diagnostic-check"),
    );
    if (owned._tag === "err" || controller.signal.aborted)
      return err(controller.signal.aborted ? "aborted" : "invalid_source");
    const scope = await mkdtemp(join(cache, DIAGNOSTIC_SCOPE_PREFIX));
    if (!isPathContained(cache, await realpath(scope)))
      return err("invalid_source");
    for (const source of [paths.dataDirectory(), paths.configDirectory()]) {
      const physical = await realpath(source);
      if (isPathContained(physical, scope) || isPathContained(scope, physical))
        return err("invalid_source");
    }
    const destination = PatchdeskPaths.fromEnvironment({
      PATCHDESK_DATA_DIRECTORY: scope,
      PATCHDESK_CONFIG_DIRECTORY: scope,
      PATCHDESK_CACHE_DIRECTORY: scope,
    });
    await mkdir(destination.reviewDirectory(selectedProfile, selectedReview), {
      recursive: true,
      mode: 0o700,
    });
    // A Guide scope is findable by a later process, which settles a run this one leaves active.
    if (
      register &&
      (
        await registerGuideScope({
          path: scope,
          profileId: selectedProfile,
          reviewId: selectedReview,
        })
      )._tag === "err"
    )
      return err("invalid_source");
    return ok(destination);
  }

  async function stage(
    request: InsightCaptureDiagnosticRequest,
    controller: AbortController,
  ): Promise<InsightCaptureDiagnosticReply> {
    const sessionId = parseReviewSessionId(request.sessionId);
    if (sessionId._tag === "err")
      return { status: "rejected", reason: "invalid_request" };
    try {
      const destination = await createScope(controller, false);
      if (destination._tag === "err")
        return {
          status: "settled",
          result: patchCaptureFailure(destination.error),
        };
      const result = await service.stage(
        selectedProfile,
        selectedReview,
        request.revision,
        sessionId.value,
        request.patchHash,
        destination.value,
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

  /** Runs complete Guide preparation in a new isolated scope; the prepared run stays owned until cancel or disposal. */
  function prepareGuide(
    request: InsightCaptureDiagnosticRequest,
    onOperation: (cancel: Operation["cancel"]) => void,
  ): Promise<InsightCaptureDiagnosticReply> {
    const settled = (
      reason: Parameters<typeof guidePreparationFailure>[0],
    ): InsightCaptureDiagnosticReply => ({
      status: "guide_settled",
      owned: false,
      result: guidePreparationFailure(reason),
    });
    const sessionId = parseReviewSessionId(request.sessionId);
    const pack = contextPack;
    const selection = request.selection;
    if (sessionId._tag === "err" || selection === undefined)
      return Promise.resolve({ status: "rejected", reason: "invalid_request" });
    if (pack === undefined)
      return Promise.resolve({ status: "rejected", reason: "transport" });
    const early = new AbortController();
    let live: ReturnType<GuidePreparationService["begin"]> | undefined;
    onOperation(async () => {
      // Before the service exists nothing is durable; afterwards the service cancels durably before it signals.
      early.abort();
      return live === undefined ? ok(undefined) : live.cancel();
    });
    return (async () => {
      try {
        const destination = await createScope(early, true);
        if (destination._tag === "err") return settled(destination.error);
        if (early.signal.aborted) return settled("aborted");
        live = new GuidePreparationService(
          paths,
          destination.value,
          resources,
          operations,
          pack,
          currentIsoTimestamp,
        ).begin({
          profileId: selectedProfile,
          reviewId: selectedReview,
          revision: request.revision,
          sessionId: sessionId.value,
          expectedHash: request.patchHash,
          selection,
        });
        const result = await live.result;
        return { status: "guide_settled", owned: live.owned(), result };
      } catch {
        return settled(early.signal.aborted ? "aborted" : "io");
      }
    })();
  }

  return {
    connectContext(pack) {
      contextPack = pack;
      // Settles runs an earlier process left active in registered Guide scopes; it never touches the source Review.
      recovery ??= (async () => {
        const cache = await realpath(paths.cacheDirectory()).catch(
          () => undefined,
        );
        if (cache === undefined) return;
        await mapConcurrent(
          await discoverGuideScopes(cache),
          4,
          async (scope) => {
            if (closed) return;
            await recoverGuideScope(
              scope,
              resources,
              operations,
              currentIsoTimestamp,
            ).catch(() => undefined);
          },
        );
      })();
    },
    install(window, origin) {
      if (closed) return;
      ipcMain.removeHandler(INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL);
      ipcMain.handle(
        INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL,
        async (
          event,
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Electron IPC payloads enter untyped and are parsed before use.
          input: unknown,
        ): Promise<InsightCaptureDiagnosticReply> => {
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
            if (
              request.action === "stage" ||
              request.action === "prepare_guide"
            )
              return { status: "rejected", reason: "already_started" };
            const reply = operation.reply;
            if (request.action !== "cancel") return reply;
            const active = operation;
            const cancellable =
              reply.status === "running" ||
              (reply.status === "guide_settled" && reply.owned);
            if (!cancellable) return reply;
            active.cancelling ??= active.cancel().finally(() => {
              active.cancelling = undefined;
            });
            const pending = active.cancelling;
            if (reply.status === "running") {
              active.reply = { status: "cancelling" };
              // A failed durable cancel left the work running and owned, so the next request may retry it.
              void pending.then((cancelled) => {
                if (
                  cancelled._tag === "err" &&
                  active.reply.status === "cancelling"
                )
                  active.reply = reply;
              });
              return active.reply;
            }
            // A prepared run stays active until this durable cancel settles it.
            const cancelled = await pending;
            if (cancelled._tag === "err")
              return { status: "rejected", reason: "cancel_failed" };
            if (reply.status === "guide_settled")
              active.reply = { ...reply, owned: false };
            return active.reply;
          }
          if (request.action !== "stage" && request.action !== "prepare_guide")
            return { status: "idle" };
          const controller = new AbortController();
          const current: Operation = {
            request,
            cancel: async () => {
              controller.abort();
              return ok(undefined);
            },
            reply: { status: "running" },
          };
          operation = current;
          const finished =
            request.action === "stage"
              ? stage(request, controller)
              : prepareGuide(request, (cancel) => {
                  current.cancel = cancel;
                });
          task = finished.then((reply) => {
            if (!closed) current.reply = reply;
          });
          return current.reply;
        },
      );
    },
    dispose() {
      if (disposal !== undefined) return disposal;
      closed = true;
      ipcMain.removeHandler(INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL);
      const active = operation;
      disposal = (async () => {
        // A cancel that cannot be confirmed leaves the run owned and active in its scope; the next start settles it.
        if (active !== undefined) await (active.cancelling ?? active.cancel());
        await task;
        await recovery;
      })();
      return disposal;
    },
  };
}
