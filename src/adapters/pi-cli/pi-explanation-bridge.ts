import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import {
  guideChildFrameSchema,
  type GuideChildFrame,
} from "#src/domain/guide-protocol";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import {
  walkthroughChildFrameSchema,
  type WalkthroughChildFrame,
} from "#src/domain/walkthrough-protocol";
import type { CodexExplanationBinding } from "#src/adapters/codex/codex-explanation-tools";
import {
  PI_EXPLANATION_WIRE_BYTES,
  PI_EXPLANATION_SOCKET_ENV,
  PI_EXPLANATION_CAPABILITY_ENV,
  piExplanationReplyFits,
} from "./pi-explanation-wire";

const requestSchema = v.strictObject({
  capability: v.string(),
  correlation: v.pipe(v.string(), v.uuid()),
  call: v.strictObject({ tool: v.string(), input: v.unknown() }),
});
/** One capability binds one host identity; existing operation services own opId receipts. */
export class PiExplanationBridge {
  private readonly capability = randomBytes(32).toString("hex");
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private directory: string | undefined;
  private admission = false;
  private correlation = 0;
  private work: Promise<void> = Promise.resolve();
  private pending = 0;
  private unknown = false;

  constructor(
    private readonly identity: ExplanationConnectionIdentity,
    private readonly binding: CodexExplanationBinding,
    private readonly halted: () => void,
    private readonly finished: () => void,
  ) {}

  async open(): Promise<NodeJS.ProcessEnv> {
    this.directory = await mkdtemp(join(await realpath("/tmp"), "pd-pi-"));
    await chmod(this.directory, 0o700);
    const path = join(this.directory, "call.sock");
    this.server = createServer((socket) => this.receive(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(path, () => resolve());
    });
    await chmod(path, 0o600);
    return {
      [PI_EXPLANATION_SOCKET_ENV]: path,
      [PI_EXPLANATION_CAPABILITY_ENV]: this.capability,
    };
  }
  admit(): void {
    this.admission = true;
  }
  closeAdmission(): void {
    this.admission = false;
  }
  async drain(): Promise<boolean> {
    await this.work;
    return !this.unknown;
  }
  async close(): Promise<void> {
    this.closeAdmission();
    await this.work;
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening)
      await new Promise<void>((resolve, reject) =>
        this.server?.close((error) => (error ? reject(error) : resolve())),
      );
    if (this.directory !== undefined)
      await rm(this.directory, { recursive: true, force: true });
  }
  private stopUnknown(): void {
    this.unknown = true;
    this.closeAdmission();
    this.halted();
  }
  private receive(socket: Socket): void {
    if (this.sockets.size >= 8) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let text = "";
    let submitted = false;
    let delivered = false;
    let parsedLine = false;
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.once("close", () => {
      this.sockets.delete(socket);
      if (submitted && !delivered) this.stopUnknown();
    });
    socket.on("data", (chunk: Buffer) => {
      if (parsedLine) {
        socket.destroy();
        return;
      }
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > PI_EXPLANATION_WIRE_BYTES) {
        socket.end('{"error":"too_large"}\n');
        return;
      }
      if (!text.endsWith("\n")) return;
      parsedLine = true;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        socket.destroy();
        return;
      }
      const request = v.safeParse(requestSchema, value);
      if (
        !request.success ||
        request.output.capability !== this.capability ||
        !this.admission ||
        this.pending >= 4
      ) {
        socket.destroy();
        return;
      }
      const frame = {
        kind: "tool",
        ...this.identity,
        correlation: ++this.correlation,
        call: request.output.call,
      };
      const parsed =
        this.binding.kind === "guide"
          ? v.safeParse(guideChildFrameSchema, frame)
          : v.safeParse(walkthroughChildFrameSchema, frame);
      if (
        !parsed.success ||
        parsed.output.kind !== "tool" ||
        Buffer.byteLength(JSON.stringify(frame)) > PI_EXPLANATION_WIRE_BYTES
      ) {
        socket.end(
          JSON.stringify({
            correlation: request.output.correlation,
            outcome: { status: "refused", reason: "invalid_input" },
          }) + "\n",
        );
        return;
      }
      const call = parsed.output.call;
      this.pending++;
      this.work = this.work
        .then(async () => {
          if (!this.admission) {
            socket.destroy();
            return;
          }
          submitted = true;
          const outcome = await this.apply(parsed.output);
          if (outcome.status === "unknown") this.stopUnknown();
          const stdout = JSON.stringify(outcome) + "\n";
          const reply =
            JSON.stringify({
              correlation: request.output.correlation,
              outcome,
            }) + "\n";
          if (
            !piExplanationReplyFits(stdout) ||
            Buffer.byteLength(reply) > PI_EXPLANATION_WIRE_BYTES
          ) {
            this.stopUnknown();
            socket.destroy();
            return;
          }
          await new Promise<void>((resolve, reject) => {
            socket.end(reply, () => {
              delivered = true;
              resolve();
            });
            socket.once("error", reject);
            socket.once("close", () => {
              if (!delivered) reject(new Error("reply_unknown"));
            });
          });
          // The finish service already froze writing. Its receipt leaves the socket before native abort is eligible.
          if (call.tool === "finish" && outcome.status === "receipt") {
            this.closeAdmission();
            this.finished();
          }
        })
        .catch(() => this.stopUnknown())
        .finally(() => {
          this.pending--;
        });
    });
  }

  private async apply(frame: GuideChildFrame | WalkthroughChildFrame) {
    if (this.binding.kind === "guide") {
      const parsed = v.parse(guideChildFrameSchema, frame);
      if (parsed.kind !== "tool") throw new Error("operation_invalid");
      return this.binding.tool(parsed.call);
    }
    const parsed = v.parse(walkthroughChildFrameSchema, frame);
    if (parsed.kind !== "tool") throw new Error("operation_invalid");
    return this.binding.tool(parsed.call);
  }
}
