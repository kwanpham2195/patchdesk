import { contextBridge, ipcRenderer } from "electron";
import * as v from "valibot";
import {
  INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL,
  insightCaptureDiagnosticReplySchema,
  insightCaptureDiagnosticRequestSchema,
  type InsightCaptureDiagnosticRequest,
  type InsightCaptureDiagnosticReply,
} from "./insight-capture-diagnostics-channel";

/** Exposes only stage/status/cancel, after the main process supplied the explicit development opt-in argument. */
export function exposeInsightCaptureDiagnostics(): void {
  contextBridge.exposeInMainWorld(
    "patchdeskInsightPatchCapture",
    Object.freeze({
      async request(
        input: InsightCaptureDiagnosticRequest,
      ): Promise<InsightCaptureDiagnosticReply> {
        const parsed = v.safeParse(
          insightCaptureDiagnosticRequestSchema,
          input,
        );
        if (!parsed.success)
          return { status: "rejected", reason: "invalid_request" };
        try {
          const response: unknown = await ipcRenderer.invoke(
            INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL,
            parsed.output,
          );
          const result = v.safeParse(
            insightCaptureDiagnosticReplySchema,
            response,
          );
          return result.success
            ? result.output
            : { status: "rejected", reason: "transport" };
        } catch {
          return { status: "rejected", reason: "transport" };
        }
      },
    }),
  );
}
