import { parentPort } from "node:worker_threads";
import * as v from "valibot";

import { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import {
  insightArtifactWorkerReplySchema,
  insightArtifactWorkerRequestSchema,
  type InsightArtifactWorkerRequest,
} from "./insight-artifact-worker-protocol";

if (parentPort === null)
  throw new Error("Insight artifact worker needs a parent port");
const port = parentPort;
let closed = false;
let busy = false;
let lastId = 0;

function closeTransport(): void {
  closed = true;
  port.close();
  process.exitCode = 1;
}

async function read(request: InsightArtifactWorkerRequest): Promise<void> {
  try {
    const result = await readBoundedInsightArtifactFile(
      request.ownedRoot,
      request.path,
    );
    const reply = v.safeParse(insightArtifactWorkerReplySchema, {
      kind: "read",
      id: request.id,
      // Copy only the observed bytes, not the physical reader's EOF/backing buffer.
      result:
        result._tag === "ok"
          ? { _tag: "ok", value: new Uint8Array(result.value) }
          : result,
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
  const request = v.safeParse(insightArtifactWorkerRequestSchema, input);
  if (!request.success || busy || request.output.id <= lastId) {
    closeTransport();
    return;
  }
  busy = true;
  lastId = request.output.id;
  void read(request.output);
});
port.on("messageerror", closeTransport);
try {
  port.postMessage({ kind: "ready" });
} catch {
  closeTransport();
}
