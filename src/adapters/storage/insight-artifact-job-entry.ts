import { parentPort } from "node:worker_threads";
import * as v from "valibot";

import {
  hashUtf8FileSha256,
  insightArtifactJobReplySchema,
  insightArtifactJobRequestSchema,
  type InsightArtifactJobRequest,
} from "./insight-artifact-job-protocol";

if (parentPort === null)
  throw new Error("Insight artifact job worker needs a parent port");
const port = parentPort;
let closed = false;
let busy = false;
let lastId = 0;

function closeTransport(): void {
  closed = true;
  port.close();
  process.exitCode = 1;
}

async function hashFile(request: InsightArtifactJobRequest): Promise<void> {
  try {
    const result = await hashUtf8FileSha256(request.path);
    const reply = v.safeParse(insightArtifactJobReplySchema, {
      kind: "hash_file",
      id: request.id,
      result,
    });
    if (!reply.success) closeTransport();
    else if (!closed) port.postMessage(reply.output);
  } catch {
    closeTransport();
  } finally {
    busy = false;
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node structured-clone messages enter untyped at this transport boundary.
port.on("message", (input: unknown) => {
  if (closed) return;
  const request = v.safeParse(insightArtifactJobRequestSchema, input);
  if (!request.success || busy || request.output.id <= lastId) {
    closeTransport();
    return;
  }
  busy = true;
  lastId = request.output.id;
  void hashFile(request.output);
});
port.on("messageerror", closeTransport);
try {
  port.postMessage({ kind: "ready" });
} catch {
  closeTransport();
}
