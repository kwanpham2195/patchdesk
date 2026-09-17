import {
  MAX_REASONING_TAIL_CHARS,
  type InsightActivityEvent,
  type InsightCommandStatus,
} from "../adapters/codex/codex-activity";
import { casesHandled } from "../domain/result";

/** Row cap; the 2026-09-17 spike saw 0 commands on a Walkthrough and 1 on an Analysis run, so the 200-row default stands. */
const MAX_ACTIVITY_COMMANDS = 200;

/** One command the running turn started, as the renderer shows it. */
export type InsightActivityCommand = {
  readonly id: string;
  readonly command: string;
  readonly status: InsightCommandStatus;
  readonly exitCode?: number | undefined;
  readonly durationMs?: number | undefined;
};

/**
 * What a running Insight is doing. `preparing` covers model discovery, thread
 * start, and prompt preparation; `turn` starts once the turn is requested.
 */
export type InsightActivitySnapshot = {
  readonly phase: "preparing" | "turn";
  readonly reasoningLine?: string | undefined;
  readonly commands: ReadonlyArray<InsightActivityCommand>;
  /** How many command approval requests Patchdesk accepted and declined in this run. */
  readonly approvals: {
    readonly accepted: number;
    readonly declined: number;
  };
};

/**
 * In-memory activity of one run, never persisted. `append` runs once per
 * provider notification, so it only mutates; `snapshot` runs once per poll and
 * does the scanning.
 */
export class InsightActivityBuffer {
  private turnStarted = false;
  private readonly commands = new Map<string, InsightActivityCommand>();
  private reasoningItemId: string | undefined;
  private reasoningTail = "";
  private acceptedApprovals = 0;
  private declinedApprovals = 0;

  /** Records one activity event. */
  append(event: InsightActivityEvent): void {
    switch (event._tag) {
      case "turn_started":
        this.turnStarted = true;
        return;
      case "command_started":
        // A start that arrives after its completion must not reopen the row.
        if (this.commands.has(event.id)) return;
        this.upsertCommand({
          id: event.id,
          command: event.command,
          status: "in_progress",
        });
        return;
      case "command_completed":
        this.upsertCommand({
          id: event.id,
          command: event.command,
          status: event.status,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
        });
        return;
      case "reasoning_delta":
        if (event.itemId !== this.reasoningItemId) {
          this.reasoningItemId = event.itemId;
          this.reasoningTail = "";
        }
        this.reasoningTail += event.delta;
        // Trimming at twice the cap keeps the per-delta cost amortised.
        if (this.reasoningTail.length > 2 * MAX_REASONING_TAIL_CHARS)
          this.reasoningTail = this.reasoningTail.slice(
            -MAX_REASONING_TAIL_CHARS,
          );
        return;
      case "approval_answered":
        if (event.decision === "accepted") this.acceptedApprovals += 1;
        else this.declinedApprovals += 1;
        return;
      default:
        return casesHandled(event);
    }
  }

  /** Projects the current activity for one poll. */
  snapshot(): InsightActivitySnapshot {
    const started =
      this.turnStarted ||
      this.commands.size > 0 ||
      this.reasoningItemId !== undefined;
    return {
      phase: started ? "turn" : "preparing",
      reasoningLine: latestReasoningLine(
        this.reasoningTail.slice(-MAX_REASONING_TAIL_CHARS),
      ),
      commands: [...this.commands.values()],
      approvals: {
        accepted: this.acceptedApprovals,
        declined: this.declinedApprovals,
      },
    };
  }

  private upsertCommand(command: InsightActivityCommand): void {
    if (
      !this.commands.has(command.id) &&
      this.commands.size >= MAX_ACTIVITY_COMMANDS
    ) {
      const oldest = this.commands.keys().next();
      if (oldest.done !== true) this.commands.delete(oldest.value);
    }
    this.commands.set(command.id, command);
  }
}

// Mirrors `latest_summary_line` in the Codex TUI (codex-rs/tui/src/chatwidget/streaming.rs).
function latestReasoningLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed.length === 0 || trimmed.startsWith("<!--")) continue;
    const heading = trimmed.replace(/^#+/u, "").trim();
    let line = heading;
    if (heading.startsWith("**")) {
      const close = heading.indexOf("**", 2);
      // An unclosed bold is a summary still streaming; fall back to an earlier line.
      if (close === -1) continue;
      line = `${heading.slice(2, close)}${heading.slice(close + 2)}`;
    }
    if (line.length > 0) return line;
  }
  return undefined;
}
