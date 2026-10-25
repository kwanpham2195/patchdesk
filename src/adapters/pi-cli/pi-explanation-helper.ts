/* oxlint-disable anti-slop/no-runtime-typeof -- Standalone helper validates its JSON boundary without runtime dependencies; the host applies the operation schemas. */
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import {
  PI_EXPLANATION_INPUT_BYTES,
  PI_EXPLANATION_WIRE_BYTES,
  PI_EXPLANATION_SOCKET_ENV,
  PI_EXPLANATION_CAPABILITY_ENV,
  piExplanationReplyFits,
} from "./pi-explanation-wire";

/** Standalone Node-mode helper holds no run authority and never retries a submission. */
async function main(): Promise<void> {
  const path = process.env[PI_EXPLANATION_SOCKET_ENV];
  const capability = process.env[PI_EXPLANATION_CAPABILITY_ENV];
  if (path === undefined || capability === undefined)
    throw new Error("bridge_unavailable");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > PI_EXPLANATION_INPUT_BYTES) throw new Error("call_too_large");
    chunks.push(buffer);
  }
  const call: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    typeof call !== "object" ||
    call === null ||
    Array.isArray(call) ||
    Object.keys(call).length !== 2 ||
    !("tool" in call) ||
    !("input" in call) ||
    typeof call.tool !== "string"
  )
    throw new Error("invalid_call");
  const correlation = randomUUID();
  const frame = JSON.stringify({ capability, correlation, call }) + "\n";
  if (Buffer.byteLength(frame) > PI_EXPLANATION_WIRE_BYTES)
    throw new Error("call_too_large");
  const text = await new Promise<string>((resolve, reject) => {
    const socket = connect(path);
    let reply = "";
    let received = false;
    socket.setTimeout(30_000, () =>
      socket.destroy(new Error("execution_unknown")),
    );
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      if (Buffer.byteLength(reply) > PI_EXPLANATION_WIRE_BYTES)
        socket.destroy(new Error("reply_too_large"));
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        const value: unknown = JSON.parse(reply);
        if (
          typeof value !== "object" ||
          value === null ||
          !("correlation" in value) ||
          value.correlation !== correlation ||
          !("outcome" in value)
        )
          throw new Error("execution_unknown");
        const output = JSON.stringify(value.outcome) + "\n";
        if (!piExplanationReplyFits(output)) throw new Error("reply_too_large");
        received = true;
        resolve(output);
      } catch {
        reject(new Error("execution_unknown"));
      }
    });
    socket.once("close", () => {
      if (!received) reject(new Error("execution_unknown"));
    });
  });
  process.stdout.write(text);
}
void main().catch((cause: unknown) => {
  // A missing receipt is outcome-unknown; provider output and environment never enter diagnostics.
  const localRefusal =
    cause instanceof Error &&
    (cause.message === "call_too_large" || cause.message === "invalid_call");
  process.stderr.write(
    localRefusal
      ? "patchdesk_operation_refused_split_or_correct_input\n"
      : "patchdesk_operation_unconfirmed\n",
  );
  process.exitCode = localRefusal ? 2 : 1;
});
