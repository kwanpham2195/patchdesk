import { parentPort } from "node:worker_threads";
import * as v from "valibot";

import {
  hashUtf8FileSha256,
  insightArtifactJobReplySchema,
  insightArtifactJobRequestSchema,
  type InsightArtifactJobRequest,
} from "./insight-artifact-job-protocol";
import { prepareGuideInputs } from "./guide-preparation-job";
import { prepareWalkthroughInputs } from "./walkthrough-preparation-job";
import { validateGuideResult } from "./guide-result-job";
import { captureInsightPatch } from "./insight-patch-capture-job";

if (parentPort === null)
  throw new Error("Insight artifact job worker needs a parent port");
const port = parentPort;
let closed = false;
let busy = false;
let lastId = 0;
let active:
  | { readonly id: number; readonly controller: AbortController }
  | undefined;

function closeTransport(): void {
  closed = true;
  port.close();
  process.exitCode = 1;
}

async function runJob(
  request: Exclude<InsightArtifactJobRequest, { kind: "cancel" }>,
): Promise<void> {
  const controller = new AbortController();
  active = { id: request.id, controller };
  try {
    const result =
      request.kind === "hash_file"
        ? await hashUtf8FileSha256(request.path)
        : request.kind === "prepare_guide"
          ? await prepareGuideInputs(request.input, {
              signal: controller.signal,
            })
          : request.kind === "prepare_walkthrough"
            ? await prepareWalkthroughInputs(request.input, {
                signal: controller.signal,
              })
            : request.kind === "validate_guide"
              ? await validateGuideResult(request.input, {
                  signal: controller.signal,
                })
              : await captureInsightPatch(request.input, {
                  signal: controller.signal,
                });
    const reply = v.safeParse(insightArtifactJobReplySchema, {
      kind: request.kind,
      id: request.id,
      result,
    });
    if (!reply.success) closeTransport();
    else if (!closed) port.postMessage(reply.output);
  } catch {
    closeTransport();
  } finally {
    busy = false;
    active = undefined;
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node structured-clone messages enter untyped at this transport boundary.
port.on("message", (input: unknown) => {
  if (closed) return;
  const request = v.safeParse(insightArtifactJobRequestSchema, input);
  if (!request.success) {
    closeTransport();
    return;
  }
  if (request.output.kind === "cancel") {
    if (request.output.id !== lastId) {
      closeTransport();
      return;
    }
    active?.controller.abort();
    return;
  }
  if (busy || request.output.id <= lastId) {
    closeTransport();
    return;
  }
  busy = true;
  lastId = request.output.id;
  void runJob(request.output);
});
port.on("messageerror", closeTransport);
try {
  port.postMessage({ kind: "ready" });
} catch {
  closeTransport();
}
