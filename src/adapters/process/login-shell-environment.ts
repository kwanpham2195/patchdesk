import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import type { Readable } from "node:stream";

import { providerCredentialEnvironmentNames } from "../pi/pi-provider-catalog";

/**
 * How long the login shell may take to print its environment. A shell whose
 * startup files hang must not hold up the app, so the wait is short and a
 * timeout imports nothing.
 */
const LOGIN_SHELL_TIMEOUT_MS = 3_000;

/** A login shell printing more than this is not printing an environment; stop reading and import nothing. */
const LOGIN_SHELL_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Used when the process has no SHELL, which is what a launchd-started app can look like. */
const FALLBACK_LOGIN_SHELL = "/bin/zsh";

/** A POSIX environment variable name. Anything else in the shell's output is malformed and dropped. */
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type LoginShellEnvironment = Readonly<Record<string, string>>;

/** The slice of a spawned child this module touches, so a test can stand in for one without a real shell. */
type LoginShellProcess = {
  readonly stdout: Readable | null;
  kill(signal: "SIGKILL"): boolean;
  once(event: "error", listener: () => void): void;
  once(event: "close", listener: (exitCode: number | null) => void): void;
};

/** The process seam. `node:child_process.spawn` satisfies it; tests inject a fake. */
type SpawnLoginShell = (
  command: string,
  args: Array<string>,
  options: { stdio: Array<"ignore" | "pipe">; shell: boolean },
) => LoginShellProcess;

type LoginShellEnvironmentOptions = {
  /** Defaults to `process.env.SHELL`, then `/bin/zsh`. */
  readonly shellPath?: string;
  readonly timeoutMs?: number;
  /** Tests inject a fake here; nothing in production passes this. */
  readonly spawnProcess?: SpawnLoginShell;
};

/** What the merge decided. Names only: a credential value never appears here. */
type LoginShellEnvironmentMerge = {
  /** The values to assign, keyed by name. */
  readonly variables: LoginShellEnvironment;
  /** The names in `variables`, sorted. Safe to log. */
  readonly importedNames: ReadonlyArray<string>;
  readonly pathReplaced: boolean;
};

/** The outcome of one import, in names only. Safe to log; safe to hand to a projection. */
type LoginShellEnvironmentImport = {
  readonly importedNames: ReadonlyArray<string>;
  readonly pathReplaced: boolean;
};

/**
 * Decides which login-shell variables Patchdesk adopts. Pure: it reads no
 * process state, spawns nothing, and mutates neither argument.
 *
 * The main process environment is a security boundary — the Insight child
 * receives only the selected provider's allowlisted names (ADR 0018) — so the
 * import is deliberately narrow. Three rules:
 *
 * - A name is adopted only when it appears in `allowedNames`, the Pi provider
 *   credential allowlist. Nothing else from the login shell is read.
 * - A name already present in `current` is never overwritten. A Patchdesk
 *   started from a terminal already carries the maintainer's own values, and
 *   those win over whatever a fresh login shell would print.
 * - PATH is replaced only when the login shell's PATH is a strict superset of
 *   the current one: every current entry appears in it, and it adds at least
 *   one entry of its own. Nothing is lost and something is gained, or nothing
 *   happens. A Dock or Finder launch gets the macOS GUI default
 *   (`/usr/bin:/bin:/usr/sbin:/sbin`), which a login shell's PATH contains and
 *   adds `/opt/homebrew/bin` to, so it is replaced and `codex` becomes
 *   discoverable. A launch that put a directory of its own on PATH keeps its
 *   PATH, and so does one that holds the same directories in a different
 *   order. PATH follows this rule whether or not it appears in `allowedNames`.
 */
export function mergeLoginShellEnvironment(
  current: Readonly<Record<string, string | undefined>>,
  loginShell: LoginShellEnvironment,
  allowedNames: ReadonlyArray<string>,
): LoginShellEnvironmentMerge {
  const variables: Record<string, string> = {};
  for (const name of new Set(allowedNames)) {
    if (name === "PATH") continue;
    const value = loginShell[name];
    if (value === undefined || current[name] !== undefined) continue;
    variables[name] = value;
  }
  const path = loginShellPathToAdopt(current.PATH, loginShell.PATH);
  if (path !== undefined) variables.PATH = path;
  return {
    variables,
    importedNames: Object.keys(variables).sort(),
    pathReplaced: path !== undefined,
  };
}

/**
 * Runs the maintainer's login shell once and returns the environment it
 * prints. `env -0` separates records with NUL so a multi-line value survives.
 * `-i` loads `~/.zshrc`, where a key export usually lives, and `-l` loads the
 * login files. The command is a fixed string with nothing interpolated into
 * it, stdin and stderr go nowhere, and any failure, timeout, or malformed
 * output yields no variables at all.
 */
export async function readLoginShellEnvironment(
  options: LoginShellEnvironmentOptions = {},
): Promise<LoginShellEnvironment> {
  const shellPath =
    options.shellPath ?? process.env.SHELL ?? FALLBACK_LOGIN_SHELL;
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;
  return new Promise<LoginShellEnvironment>((resolve) => {
    let child;
    try {
      child = spawnProcess(shellPath, ["-ilc", "env -0"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve({});
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (environment: LoginShellEnvironment): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(environment);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({});
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > LOGIN_SHELL_MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({});
      }
    });
    child.once("error", () => finish({}));
    child.once("close", (exitCode: number | null) => {
      finish(exitCode === 0 ? parseNulSeparatedEnvironment(stdout) : {});
    });
  });
}

/**
 * Imports the login shell's PATH and Pi provider credentials into `target`,
 * so a Patchdesk opened from the Dock or Finder finds the same API keys and
 * the same `codex` executable a terminal launch finds. macOS only; on any
 * other platform it imports nothing.
 *
 * This mutates `target`, which defaults to the main process environment. Call
 * it once at startup, before the Insight provider catalog reads a key or
 * executable discovery reads PATH. Only names, never values, come back.
 */
export async function importLoginShellEnvironment(
  target: Record<string, string | undefined> = process.env,
  options: LoginShellEnvironmentOptions = {},
): Promise<LoginShellEnvironmentImport> {
  if (process.platform !== "darwin")
    return { importedNames: [], pathReplaced: false };
  const merge = mergeLoginShellEnvironment(
    target,
    await readLoginShellEnvironment(options),
    providerCredentialEnvironmentNames(),
  );
  for (const name of merge.importedNames) {
    const value = merge.variables[name];
    if (value !== undefined) target[name] = value;
  }
  return {
    importedNames: merge.importedNames,
    pathReplaced: merge.pathReplaced,
  };
}

/** Parses `env -0` output. A record without a name, or with a name no shell could export, is dropped. */
function parseNulSeparatedEnvironment(output: string) {
  const variables: Record<string, string> = {};
  for (const record of output.split("\0")) {
    const separator = record.indexOf("=");
    if (separator <= 0) continue;
    const name = record.slice(0, separator);
    if (!ENVIRONMENT_VARIABLE_NAME.test(name)) continue;
    variables[name] = record.slice(separator + 1);
  }
  return variables;
}

/** The login shell's PATH when it is safe to adopt, otherwise undefined. See the PATH rule on `mergeLoginShellEnvironment`. */
function loginShellPathToAdopt(
  current: string | undefined,
  loginShell: string | undefined,
): string | undefined {
  if (loginShell === undefined || loginShell.length === 0) return undefined;
  if (current === undefined || current.length === 0) return loginShell;
  const currentEntries = new Set(pathEntries(current));
  const loginShellEntries = new Set(pathEntries(loginShell));
  const keepsEverything = [...currentEntries].every((entry) =>
    loginShellEntries.has(entry),
  );
  const addsSomething = [...loginShellEntries].some(
    (entry) => !currentEntries.has(entry),
  );
  return keepsEverything && addsSomething ? loginShell : undefined;
}

function pathEntries(value: string): ReadonlyArray<string> {
  return value.split(delimiter).filter((entry) => entry.length > 0);
}
