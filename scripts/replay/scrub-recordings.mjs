#!/usr/bin/env node
// @ts-nocheck -- a dev script over untyped JSON recordings.
// Turns raw `PATCHDESK_REPLAY_RECORD` output into committable replay fixtures (#862).
//
//   node scripts/replay/scrub-recordings.mjs <raw-root> <out-dir>
//
// <raw-root> holds one folder per Insight type (brief, analysis, walkthrough,
// guide), each with the per-child files of one recorded run. Only the turn
// child's traffic from `thread/start` on is kept: the replayer answers the
// preamble (config, skills, account) itself, because those responses carry the
// recording machine's configuration, API keys and account details. Client
// requests keep only their method and id; server messages are scrubbed.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [rawRoot, outDirectory] = process.argv.slice(2);
if (rawRoot === undefined || outDirectory === undefined) {
  console.error("usage: scrub-recordings.mjs <raw-root> <out-dir>");
  process.exit(2);
}

const DROPPED_SERVER_METHODS = new Set([
  "remoteControl/status/changed",
  "account/updated",
  "account/login/completed",
  "account/rateLimits/updated",
  "turn/moderationMetadata",
]);
const SENSITIVE_KEYS = new Set([
  "email",
  "accessToken",
  "access_token",
  "chatgptAccountId",
  "accountId",
  "account_id",
]);

/** @param {string} text @param {string} worktree */
function scrubText(text, worktree) {
  let out = text;
  if (worktree !== "") out = out.split(worktree).join("<WORKTREE>");
  out = out
    .replace(
      /(?:\/private)?\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/T\/patchdesk-codex-insight-[A-Za-z0-9]+/g,
      "<CODEX_HOME>",
    )
    .replace(
      /\/Users\/kwanpham\/Work\/personal\/patchdesk(?:\/\.claude\/worktrees\/[A-Za-z0-9-]+)?/g,
      "/home/replay/patchdesk",
    )
    .replace(/\/Users\/kwanpham/g, "/home/replay")
    .replace(/kwanpham2195/g, "replay-owner")
    .replace(/kwanpham/g, "replay-user")
    .replace(/quanpm[A-Za-z0-9._]*/g, "replay-user")
    .replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "user@example.invalid",
    )
    .replace(
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
      "<TOKEN>",
    )
    .replace(/\b(?:sk|ghp|gho|ghs|ghu)[-_][A-Za-z0-9_-]{8,}/g, "<TOKEN>");
  return out;
}

/** @param {unknown} value */
function dropSensitiveKeys(value) {
  if (Array.isArray(value)) return value.map(dropSensitiveKeys);
  if (value instanceof Object) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SENSITIVE_KEYS.has(key) ? "<REDACTED>" : dropSensitiveKeys(inner),
      ]),
    );
  }
  return value;
}

mkdirSync(outDirectory, { recursive: true });
for (const type of ["brief", "analysis", "walkthrough", "guide"]) {
  const directory = join(rawRoot, type);
  const sessions = readdirSync(directory)
    .sort()
    .map((name) =>
      readFileSync(join(directory, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  const turn = sessions.find((events) =>
    events.some((event) => event.message?.method === "thread/start"),
  );
  if (turn === undefined) throw new Error(`${type}: no turn session`);
  const start = turn.findIndex(
    (event) => event.dir === "c2s" && event.message?.method === "thread/start",
  );
  const worktree = turn[start].message.params.cwd;
  const base = turn[start].t;
  const kept = [];
  for (const event of turn.slice(start)) {
    const message = event.message;
    if (message === undefined) throw new Error(`${type}: undecodable line`);
    if (event.dir === "s2c" && DROPPED_SERVER_METHODS.has(message.method))
      continue;
    const t = event.t - base;
    if (event.dir === "c2s") {
      // Client payloads (prompt, tool arguments, tool results) are never replayed.
      kept.push({
        dir: "c2s",
        t,
        message:
          message.method === undefined
            ? { id: message.id, result: {} }
            : message.id === undefined
              ? { method: message.method }
              : { id: message.id, method: message.method },
      });
      continue;
    }
    const scrubbed = JSON.parse(
      scrubText(JSON.stringify(dropSensitiveKeys(message)), worktree),
    );
    kept.push({ dir: "s2c", t, message: scrubbed });
  }
  const output = kept.map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(join(outDirectory, `${type}.jsonl`), `${output}\n`);
  console.log(`${type}: ${kept.length} events, ${output.length} bytes`);
}
