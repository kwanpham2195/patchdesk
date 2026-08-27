import * as v from "valibot";

import { requestJson } from "../api-client";

import { definedProps } from "../../../domain/defined-props";
import type { LogMetaInput } from "../../../domain/log-entry";

export type RendererLogLevel = "debug" | "info" | "warn" | "error";

type PendingLogEntry = {
  readonly level: RendererLogLevel;
  readonly topic: string;
  readonly message: string;
  readonly meta?: LogMetaInput;
};

const MAX_QUEUE = 200;
const FLUSH_DELAY_MS = 300;

const queue: PendingLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let captureInstalled = false;

/** Renderer-side log stream; forwarded in batches to the main-process log service. */
export const appLog = {
  debug(topic: string, message: string, meta?: LogMetaInput): void {
    enqueue("debug", topic, message, meta);
  },
  info(topic: string, message: string, meta?: LogMetaInput): void {
    enqueue("info", topic, message, meta);
  },
  warn(topic: string, message: string, meta?: LogMetaInput): void {
    enqueue("warn", topic, message, meta);
  },
  error(topic: string, message: string, meta?: LogMetaInput): void {
    enqueue("error", topic, message, meta);
  },
};

function enqueue(
  level: RendererLogLevel,
  topic: string,
  message: string,
  meta?: LogMetaInput,
): void {
  queue.push({
    level,
    topic,
    message,
    ...definedProps({ meta }),
  });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, FLUSH_DELAY_MS);
  }
}

async function flush(): Promise<void> {
  const batch = queue.splice(0, queue.length);
  if (batch.length === 0) return;
  try {
    await requestJson("/v1/logs", { method: "POST", body: { entries: batch } });
  } catch {
    // Logging must never break the app; drop the batch on failure.
  }
}

/** Capture console error/warn plus window-level failures once per renderer boot. */
export function installRendererLogging(): void {
  if (captureInstalled) return;
  captureInstalled = true;

  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]): void => {
    originalError(...args);
    appLog.error("console", formatArgs(args));
  };
  console.warn = (...args: unknown[]): void => {
    originalWarn(...args);
    appLog.warn("console", formatArgs(args));
  };

  window.addEventListener("error", (event) => {
    appLog.error("window-error", event.message || "Uncaught renderer error", {
      file: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    appLog.error(
      "unhandled-rejection",
      reason instanceof Error ? reason.message : String(reason),
      { stack: reason instanceof Error ? reason.stack : undefined },
    );
  });
}

function formatArgs(args: ReadonlyArray<unknown>): string {
  try {
    return args
      .map((arg) => {
        // Console hands an interceptor whatever the caller passed. Parse the
        // one shape that must print unquoted, then fall back to JSON.
        const text = v.safeParse(v.string(), arg);
        if (text.success) return text.output;
        if (arg instanceof Error) return arg.message;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ")
      .slice(0, 1_000);
  } catch {
    return "unprintable console arguments";
  }
}
