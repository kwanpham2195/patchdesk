import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

/** A fake `pi` for PiRpcClient tests: `--version` prints a version, `--mode rpc` answers commands from a script. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };
export type JsonRecord = { readonly [key: string]: JsonValue };
type Spawned = {
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnOptions;
};

/** One scripted `pi` child: `--version` prints a version, `--mode rpc` answers commands. */
class FakePiProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<JsonRecord> = [];

  constructor(
    private readonly answer: (
      command: JsonRecord,
      write: (record: JsonRecord) => void,
    ) => void,
  ) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // SAFETY: the client under test writes one JSON object per line, built from strings and booleans.
        const command = JSON.parse(line) as JsonRecord;
        this.received.push(command);
        this.answer(command, (record) => this.write(record));
      }
    });
  }

  write(record: JsonRecord): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  kill(): boolean {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

/**
 * The ChildProcess surface the pi client reads: the three pipes, kill(), and
 * once()/on() listeners. `once` returns `void` so any EventEmitter satisfies it.
 */
type ChildProcessSurface = {
  readonly stdin: ChildProcess["stdin"];
  readonly stdout: ChildProcess["stdout"];
  readonly stderr: ChildProcess["stderr"];
  kill(): boolean;
  once(event: string, listener: (...args: unknown[]) => void): void;
};

function asChildProcess(fake: FakePiProcess): ChildProcess {
  const surface: ChildProcessSurface = fake;
  // SAFETY: the pi client only reads the three pipes, calls kill(), and listens for "error", "exit", and "close"; FakePiProcess provides exactly that surface.
  return surface as ChildProcess;
}

type RpcScript = (
  command: JsonRecord,
  write: (record: JsonRecord) => void,
  child: FakePiProcess,
) => void;

export function fakePi(options: {
  readonly version?: string;
  /** Holds `pi --version` open until it settles, so a test can act while the version check runs. */
  readonly versionReleased?: Promise<void>;
  readonly rpc: RpcScript;
}) {
  const spawned: Array<Spawned> = [];
  const children: Array<FakePiProcess> = [];
  const processFactory = (
    _file: string,
    args: ReadonlyArray<string>,
    spawnOptions: SpawnOptions,
  ): ChildProcess => {
    spawned.push({ args, options: spawnOptions });
    if (args[0] === "--version") {
      const versionChild = new FakePiProcess(() => undefined);
      void (options.versionReleased ?? Promise.resolve()).then(() => {
        versionChild.stdout.write(`${options.version ?? "0.87.1"}\n`);
        setImmediate(() => versionChild.emit("close", 0, null));
      });
      return asChildProcess(versionChild);
    }
    const child: FakePiProcess = new FakePiProcess((command, write) =>
      options.rpc(command, write, child),
    );
    children.push(child);
    return asChildProcess(child);
  };
  return { spawned, children, processFactory };
}

export function respond(command: JsonRecord, fields: JsonRecord = {}) {
  return {
    type: "response",
    id: command.id ?? null,
    command: command.type ?? null,
    success: true,
    ...fields,
  } satisfies JsonRecord;
}

/** A pi session that resolved the requested model and answers the prompt with `answer` events. */
export function runScript(
  answer: (write: (record: JsonRecord) => void) => void,
  prompt: (command: JsonRecord) => JsonRecord = (command) => respond(command),
): RpcScript {
  return (command, write) => {
    if (command.type === "get_state")
      write(
        respond(command, {
          data: {
            model: { provider: "anthropic", id: "claude-sonnet-5" },
            thinkingLevel: "high",
          },
        }),
      );
    if (command.type === "prompt") {
      const response = prompt(command);
      write(response);
      if (response.success === true) answer(write);
    }
  };
}

export function assistantAnswer(text: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Reading the patch" },
        { type: "text", text },
      ],
      stopReason: "stop",
    },
  } satisfies JsonRecord;
}
