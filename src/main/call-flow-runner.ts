import {
  analyzeCallFlow,
  parseCallFlowInvocation,
} from "../services/call-flow-operation";

const MAX_STDIN_BYTES = 32 * 1024;

export async function runCallFlowChildProcess(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const raw = await readBoundedStdin(input);
  if (raw === undefined) {
    output.write(JSON.stringify({ ok: false, reason: "invalid_input" }));
    return;
  }
  try {
    // SAFETY: JSON.parse is narrowed immediately by parseCallFlowInvocation before any field is read.
    const invocation = parseCallFlowInvocation(JSON.parse(raw) as unknown);
    if (invocation === undefined) {
      output.write(JSON.stringify({ ok: false, reason: "invalid_input" }));
      return;
    }
    output.write(
      JSON.stringify({ ok: true, value: analyzeCallFlow(invocation) }),
    );
  } catch {
    output.write(JSON.stringify({ ok: false, reason: "execution_failed" }));
  }
}

async function readBoundedStdin(
  input: NodeJS.ReadableStream,
): Promise<string | undefined> {
  const chunks: Array<Buffer> = [];
  let bytes = 0;
  for await (const chunk of input) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += next.byteLength;
    if (bytes > MAX_STDIN_BYTES) return undefined;
    chunks.push(next);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === `file://${process.argv[1]}`)
  await runCallFlowChildProcess(process.stdin, process.stdout);
