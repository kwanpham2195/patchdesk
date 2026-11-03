#!/usr/bin/env node
// @ts-nocheck -- a self-contained dev fake; its JSON-RPC messages are untyped by design.
// A fake `codex app-server` for dev-only Insight checks (#862).
//
// `pnpm dev` with PATCHDESK_REPLAY_PROVIDER=1 resolves every Codex lookup to this
// file (src/main/codex-replay-dev.ts). It speaks the app-server JSON-RPC protocol
// over stdio: the preamble (initialize, config, skills, account, model/list) is
// answered from synthetic data, and a turn replays the scrubbed recording in
// fixtures/replay/ chosen by the model id (replay-brief, replay-analysis,
// replay-walkthrough, replay-guide). Recorded server messages are emitted at a
// fixed pace; client requests are matched to the recording by method, so the
// app's own request ids are answered, not the recorded ones.
//
// Drift (a request the recording lacks, a missing client reply) is logged to
// `$TMPDIR/patchdesk-replay.log` with a reason code, answered with a JSON-RPC
// error, and ends the process, so the run fails instead of hanging.
import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PACE_MS = 60;
const SILENT_CLIENT_MS = 30_000;
const RECORDINGS = new URL("../../fixtures/replay/", import.meta.url);
const TYPES = ["brief", "analysis", "walkthrough", "guide"];
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const LOG_PATH = join(tmpdir(), "patchdesk-replay.log");

const hasResourceArgs = process.argv.some((arg) =>
  arg.startsWith("skills.config="),
);
let worktree = process.cwd();
const codexHome = process.env.CODEX_HOME ?? "/home/replay/.codex";

/** @type {{ dir: string; t: number; message: any }[]} */
let events = [];
let cursor = 0;
const consumed = new Set();
let started = false;
let finished = false;
let interrupted = false;
let pumping = false;
let threadId = "";
let turnId = "";
let silenceTimer;

function log(reason, fields = {}) {
  try {
    appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, reason, ...fields })}\n`,
    );
  } catch {
    // The log is a diagnostic aid; a write failure changes nothing.
  }
}

function localize(message) {
  return JSON.parse(
    JSON.stringify(message)
      .split("<WORKTREE>")
      .join(worktree)
      .split("<CODEX_HOME>")
      .join(codexHome),
  );
}

function write(message) {
  process.stdout.write(`${JSON.stringify(localize(message))}\n`);
}

function respond(id, result) {
  write({ id, result });
}

function fail(id, reason, fields = {}, exitCode = 3) {
  log(reason, fields);
  if (id !== undefined)
    write({ id, error: { code: -32000, message: `replay_drift:${reason}` } });
  // Let the error reach the app before the process disappears.
  setTimeout(() => process.exit(exitCode), 50);
}

const modelEntries = TYPES.map((type) => ({
  id: `replay-${type}`,
  displayName: `Replay ${type}`,
  hidden: false,
  supportedReasoningEfforts: EFFORTS.map((reasoningEffort) => ({
    reasoningEffort,
  })),
  defaultReasoningEffort: "medium",
}));

/** Synthetic preamble: the shapes the app reads, never the recording machine's real configuration. */
function preamble(method, params) {
  const server = (enabled) => ({
    replay_server: {
      url: "https://example.invalid/mcp",
      environment_id: "local",
      enabled,
      tool_timeout_sec: null,
    },
  });
  switch (method) {
    case "initialize":
      return {
        userAgent: "patchdesk/0.0.0-replay (replay; replay)",
        codexHome,
        platformFamily: "unix",
        platformOs: "macos",
      };
    case "config/read": {
      const isolated = hasResourceArgs;
      const result = {
        config: {
          model_provider: null,
          model_providers: {},
          openai_base_url: null,
          chatgpt_base_url: "https://chatgpt.example.invalid/backend-api/",
          mcp_servers: server(!isolated),
          features: {
            apps: false,
            enable_mcp_apps: false,
            hooks: false,
            plugins: false,
          },
          skills: {
            bundled: { enabled: false },
            include_instructions: false,
          },
          project_doc_max_bytes: 0,
          developer_instructions: "",
        },
        origins: {},
      };
      if (params?.includeLayers === true)
        result.layers = [
          {
            name: { type: "sessionFlags" },
            config: { cli_auth_credentials_store: "ephemeral" },
          },
          {
            name: { type: "user", file: `${codexHome}/config.toml` },
            config: {},
          },
        ];
      return result;
    }
    case "skills/list":
      return {
        data: [
          {
            cwd: worktree,
            skills: [
              {
                name: "replay-skill",
                description: "A skill that exists only in the replay.",
                path: "/home/replay/.agents/skills/replay-skill/SKILL.md",
                scope: "user",
                enabled: !hasResourceArgs,
                pluginId: null,
              },
            ],
            errors: [],
          },
        ],
      };
    case "account/login/start":
      return { type: "chatgptAuthTokens" };
    case "configRequirements/read":
      return { supportsIndependentSpeedModes: true, requirements: null };
    case "account/read":
      return {
        account: {
          type: "chatgpt",
          email: "replay@example.invalid",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      };
    case "model/list":
      return { data: modelEntries, nextCursor: null };
    default:
      return undefined;
  }
}

function isServerNotification(event) {
  return event.dir === "s2c" && event.message.method !== undefined;
}

function startTurn(id, params) {
  const type = TYPES.find((name) => `replay-${name}` === params?.model);
  if (type === undefined)
    return fail(id, "replay_unknown_model", { model: params?.model });
  try {
    events = readFileSync(new URL(`${type}.jsonl`, RECORDINGS), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return fail(id, "replay_recording_unreadable", { type });
  }
  if (params.cwd) worktree = params.cwd;
  started = true;
  // events[0] is the recorded thread/start request; answer it from its recorded response.
  consumed.add(0);
  const recorded = events.find(
    (event) => event.dir === "s2c" && event.message.id === events[0].message.id,
  )?.message.result;
  if (recorded === undefined)
    return fail(id, "replay_recording_incomplete", { type });
  threadId = recorded.thread?.id ?? "";
  const effort = params.config?.model_reasoning_effort;
  const reply = structuredClone(recorded);
  reply.model = params.model;
  reply.reasoningEffort = effort;
  if (reply.thread !== undefined) {
    reply.thread.model = params.model;
    reply.thread.reasoningEffort = effort;
  }
  respond(id, reply);
  log("replay_turn_started", { type, model: params.model });
  void pump();
}

/** Emits recorded server messages until the recording waits on the client. */
async function pump() {
  if (pumping || finished) return;
  pumping = true;
  clearTimeout(silenceTimer);
  try {
    while (!finished && !interrupted) {
      const event = events[cursor];
      if (event === undefined) break;
      if (
        (event.dir === "s2c" && event.message.method === undefined) ||
        consumed.has(cursor)
      ) {
        cursor += 1;
        continue;
      }
      if (event.dir === "c2s") {
        armSilenceWatchdog(event);
        return;
      }
      clearTimeout(silenceTimer);
      await new Promise((resolve) => setTimeout(resolve, PACE_MS));
      if (interrupted) return;
      // A client message may have flushed this event and moved the cursor while it slept.
      if (events[cursor] !== event) continue;
      write(event.message);
      cursor += 1;
    }
  } finally {
    pumping = false;
  }
}

function armSilenceWatchdog(event) {
  clearTimeout(silenceTimer);
  // Trailing client messages (the app's final interrupt) are not waited for.
  if (!events.slice(cursor).some(isServerNotification)) return;
  silenceTimer = setTimeout(
    () =>
      fail(
        undefined,
        "replay_client_silent",
        {
          waitingFor: event.message.method ?? "reply",
        },
        4,
      ),
    SILENT_CLIENT_MS,
  );
  silenceTimer.unref();
}

/** The recorded client messages the next server message is still waiting behind. */
function pendingWindow() {
  const indexes = [];
  for (let index = cursor; index < events.length; index += 1) {
    const event = events[index];
    if (isServerNotification(event)) break;
    if (event.dir === "c2s" && !consumed.has(index)) indexes.push(index);
  }
  return indexes;
}

/**
 * The recorded client message `predicate` accepts. The client can be quicker
 * than the paced notifications recorded before its message; those are flushed
 * in order so the recording stays the source of ordering. A turn/interrupt never
 * takes this path: one that is not in the window is a mid-stream interrupt.
 */
function findMatch(predicate, lenient) {
  const inWindow = pendingWindow().find(predicate);
  if (inWindow !== undefined || !lenient) return inWindow;
  for (let index = cursor; index < events.length; index += 1) {
    const event = events[index];
    if (event.dir !== "c2s" || consumed.has(index)) continue;
    if (!predicate(index)) return undefined;
    for (let flush = cursor; flush < index; flush += 1)
      if (isServerNotification(events[flush])) write(events[flush].message);
    cursor = index;
    return index;
  }
  return undefined;
}

function interruptMidStream(id) {
  interrupted = true;
  finished = true;
  clearTimeout(silenceTimer);
  log("replay_interrupted", { cursor, of: events.length });
  if (id !== undefined) respond(id, {});
  write({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, items: [], status: "interrupted", error: null },
    },
  });
}

function handleTailRequest(message) {
  const { id, method } = message;
  const match = findMatch(
    (index) => events[index].message.method === method,
    method !== "turn/interrupt",
  );
  if (match === undefined) {
    if (method === "turn/interrupt") return interruptMidStream(id);
    return fail(id, "replay_unexpected_request", { method, cursor });
  }
  consumed.add(match);
  const recordedId = events[match].message.id;
  const recorded = events.find(
    (event) =>
      event.dir === "s2c" &&
      event.message.method === undefined &&
      event.message.id === recordedId,
  );
  const result = recorded?.message.result ?? {};
  if (method === "turn/start") turnId = result.turn?.id ?? "";
  respond(id, result);
  void pump();
}

function handleTailNotification(message) {
  const match = findMatch(
    (index) =>
      events[index].message.method === message.method &&
      events[index].message.id === undefined,
    message.method !== "turn/interrupt",
  );
  if (match !== undefined) {
    consumed.add(match);
    void pump();
  } else if (message.method === "turn/interrupt") interruptMidStream(undefined);
}

function handleTailResponse(message) {
  const match = findMatch(
    (index) =>
      events[index].message.method === undefined &&
      String(events[index].message.id) === String(message.id),
    true,
  );
  if (match === undefined)
    return fail(undefined, "replay_unexpected_reply", { id: message.id });
  consumed.add(match);
  void pump();
}

function handle(message) {
  const isRequest = message.method !== undefined && message.id !== undefined;
  const isReply = message.method === undefined && message.id !== undefined;
  if (finished) return;
  if (!started) {
    if (!isRequest) return;
    if (message.method === "thread/start")
      return startTurn(message.id, message.params);
    const result = preamble(message.method, message.params);
    if (result === undefined) {
      log("replay_unsupported_preamble_request", { method: message.method });
      return write({
        id: message.id,
        error: { code: -32601, message: "replay_unsupported_request" },
      });
    }
    if (message.method === "skills/list" && message.params?.cwds?.[0])
      worktree = message.params.cwds[0];
    if (message.method === "config/read" && message.params?.cwd)
      worktree = message.params.cwd;
    return respond(message.id, result);
  }
  if (isRequest) return handleTailRequest(message);
  if (isReply) return handleTailResponse(message);
  return handleTailNotification(message);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return fail(undefined, "replay_undecodable_input");
  }
  handle(message);
});
input.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
