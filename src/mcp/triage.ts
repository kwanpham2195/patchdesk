import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, release, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { isPathContained } from "#src/adapters/storage/path-containment";
import { callPatchdeskApp } from "./socket-client";

const execFileAsync = promisify(execFile);

export type TriageChannel = "installed" | "dev" | "worktree" | "dev-shared";

type LogFileFact = {
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: string;
};

export type TriageFacts = {
  readonly generatedAt: string;
  readonly version: string;
  readonly channel: TriageChannel;
  /** The commit the shim was built from, or "unknown" when the build could not read git. */
  readonly commit: string;
  readonly macOSVersion: string;
  readonly kernel: string;
  readonly architecture: string;
  readonly appRunning: boolean;
  readonly socketPath: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
  readonly logsDirectory: string;
  /** The active log first, then rotated logs, newest first; empty when none exists. */
  readonly logFiles: ReadonlyArray<LogFileFact>;
  readonly sourceCacheDirectory: string;
};

/** The home directory as `~`, so a context file pasted into an issue names no user. */
function redactHome(path: string, home: string): string {
  return isPathContained(home, path) ? join("~", relative(home, path)) : path;
}

/**
 * Whether the app answers on its socket. `list_repositories` only reads, and
 * any reply other than a refusal to connect proves a process is listening.
 */
async function appIsRunning(socketPath: string): Promise<boolean> {
  const call = await callPatchdeskApp(
    socketPath,
    { tool: "list_repositories", arguments: {} },
    { maxRequestBytes: 1024, maxReplyBytes: 4 * 1024 * 1024, timeoutMs: 3_000 },
  );
  return call.reply.ok || call.reply.error !== "app_not_running";
}

async function macOSVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("sw_vers", ["-productVersion"], {
      timeout: 3_000,
    });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** The active log and its rotations; a missing directory is a fact (no log yet), not a failure. */
async function describeLogs(
  paths: Pick<PatchdeskPaths, "logsDirectory" | "logFile">,
): Promise<ReadonlyArray<LogFileFact>> {
  let names: string[];
  try {
    names = await readdir(paths.logsDirectory());
  } catch {
    return [];
  }
  const files: LogFileFact[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
    const path = join(paths.logsDirectory(), name);
    try {
      const stats = await stat(path);
      files.push({
        path,
        bytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    } catch {
      // A rotation can remove the file between readdir and stat.
    }
  }
  const active = paths.logFile();
  return files.sort(
    (left, right) =>
      Number(right.path === active) - Number(left.path === active) ||
      right.modifiedAt.localeCompare(left.modifiedAt),
  );
}

export async function collectTriageFacts(input: {
  readonly version: string;
  readonly commit: string;
  readonly channel: TriageChannel;
  readonly paths: PatchdeskPaths;
  readonly socketPath: string;
  readonly now: Date;
}): Promise<TriageFacts> {
  const { paths } = input;
  const [running, macOS, logFiles] = await Promise.all([
    appIsRunning(input.socketPath),
    macOSVersion(),
    describeLogs(paths),
  ]);
  return {
    generatedAt: input.now.toISOString(),
    version: input.version,
    channel: input.channel,
    commit: input.commit,
    macOSVersion: macOS,
    kernel: release(),
    architecture: process.arch,
    appRunning: running,
    socketPath: input.socketPath,
    configDirectory: paths.configDirectory(),
    dataDirectory: paths.dataDirectory(),
    cacheDirectory: paths.cacheDirectory(),
    logsDirectory: paths.logsDirectory(),
    logFiles,
    sourceCacheDirectory: join(triageDirectory(), "source"),
  };
}

function triageDirectory(): string {
  return join(tmpdir(), "patchdesk-triage");
}

/**
 * Markdown, because an agent reads it as prose beside the playbook and a
 * person can read it too; every home-directory prefix is redacted.
 */
function renderTriageContext(
  facts: TriageFacts,
  home: string = homedir(),
): string {
  const path = (value: string): string => redactHome(value, home);
  const sourceRef =
    facts.channel === "installed"
      ? `\`v${facts.version}\` tag (this is a packaged release)`
      : facts.commit === "unknown"
        ? "unknown: this dev build recorded no commit"
        : `commit \`${facts.commit.replace("+dirty", "")}\` (a dev build has no release tag${facts.commit.endsWith("+dirty") ? "; the build had uncommitted changes, so line numbers can be off" : ""})`;
  const logs =
    facts.logFiles.length === 0
      ? ["- No log file exists yet."]
      : facts.logFiles.map(
          (file, index) =>
            `- ${index === 0 ? "active: " : "rotated: "}\`${path(file.path)}\`, ${file.bytes} bytes, modified ${file.modifiedAt}`,
        );
  return `${[
    "# Patchdesk triage context",
    "",
    `Generated ${facts.generatedAt} by \`patchdesk triage\`.`,
    "",
    "## Triage CLI build",
    "",
    "These describe the `patchdesk` command that wrote this file. The app that",
    "showed the bug can be another build: ask the user, and read the running",
    "app's version from Settings or `patchdesk setup status` before trusting it.",
    "",
    `- Version: ${facts.version}`,
    `- Channel: ${facts.channel}`,
    `- Commit: ${facts.commit}`,
    `- Source ref to read: ${sourceRef}`,
    "",
    "## Machine",
    "",
    `- macOS: ${facts.macOSVersion} (Darwin ${facts.kernel}, ${facts.architecture})`,
    `- App answering on its MCP socket: ${facts.appRunning ? "yes" : "no"} (\`${path(facts.socketPath)}\`). "No" also holds while the app is open but refused to start, so check the process list.`,
    "",
    "## Paths",
    "",
    `- Config: \`${path(facts.configDirectory)}\``,
    `- Data: \`${path(facts.dataDirectory)}\``,
    `- Cache: \`${path(facts.cacheDirectory)}\``,
    `- Logs: \`${path(facts.logsDirectory)}\``,
    `- Source cache for the playbook: \`${path(facts.sourceCacheDirectory)}\``,
    "",
    "## Log files",
    "",
    ...logs,
  ].join("\n")}\n`;
}

/** Writes the context to a fresh file under the temp directory and returns its path; the app's stores are never touched. */
export async function writeTriageContext(
  facts: TriageFacts,
  home?: string,
): Promise<string> {
  const directory = triageDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(
    directory,
    `context-${facts.generatedAt.replaceAll(/[:.]/g, "-")}.md`,
  );
  await writeFile(file, renderTriageContext(facts, home), { mode: 0o600 });
  return file;
}
