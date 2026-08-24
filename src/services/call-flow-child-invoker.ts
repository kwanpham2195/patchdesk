import type { CommandRunner } from "../adapters/github/command-runner";
import type { CallFlowOutcome } from "../domain/call-flow";
import { err, ok, type Result } from "../domain/result";
import * as v from "valibot";
import {
  parseCallFlowOutcome,
  type CallFlowInvocation,
} from "./call-flow-operation";

export type CallFlowChildFailure = {
  readonly reason:
    | "cancelled"
    | "runtime_unavailable"
    | "timed_out"
    | "execution_failed"
    | "invalid_result";
};

/** Runs the deterministic CallDiff engine outside the Electron main event loop. */
export class CallFlowChildInvoker {
  constructor(
    private readonly commands: Pick<CommandRunner, "runJson">,
    private readonly runnerPath: string,
    private readonly runtimeExecutable = process.execPath,
  ) {}

  async invoke(
    input: CallFlowInvocation,
  ): Promise<Result<CallFlowOutcome, CallFlowChildFailure>> {
    const output = await this.commands.runJson({
      argv: [this.runtimeExecutable, this.runnerPath],
      cwd: input.worktreePath,
      stdin: JSON.stringify(input),
      timeoutMs: 30_000,
      environment: {
        ELECTRON_RUN_AS_NODE: "1",
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
      },
      inheritEnvironment: false,
    });
    if (output._tag === "err") {
      return err({
        reason:
          output.error._tag === "CommandAborted"
            ? "cancelled"
            : output.error._tag === "CommandTimedOut"
              ? "timed_out"
              : output.error._tag === "CommandUnavailable" ||
                  output.error._tag === "CommandRuntimeUnavailable" ||
                  output.error._tag === "CommandNotFound"
                ? "runtime_unavailable"
                : "execution_failed",
      });
    }
    const response = parseResponse(output.value);
    if (response === undefined) return err({ reason: "invalid_result" });
    return response.ok
      ? ok(response.value)
      : err({
          reason:
            response.reason === "execution_failed"
              ? "execution_failed"
              : "invalid_result",
        });
  }
}

const childResponseSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true), value: v.unknown() }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.picklist(["invalid_input", "execution_failed"]),
  }),
]);

function parseResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the child stdout JSON boundary parser.
  input: unknown,
):
  | { readonly ok: true; readonly value: CallFlowOutcome }
  | { readonly ok: false; readonly reason: string }
  | undefined {
  const parsed = v.safeParse(childResponseSchema, input);
  if (!parsed.success) return undefined;
  if (!parsed.output.ok) return { ok: false, reason: parsed.output.reason };
  const value = parseCallFlowOutcome(parsed.output.value);
  return value === undefined ? undefined : { ok: true, value };
}
