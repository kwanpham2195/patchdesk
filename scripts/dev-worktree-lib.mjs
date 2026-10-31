import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The main checkout's fixed dev ports; a worktree profile never derives either one. */
export const MAIN_CDP_PORT = 9233;
export const MAIN_VITE_PORT = 5173;

/** Folder inside a worktree holding its dev config, data, cache and Electron user data. Gitignored. */
export const WORKTREE_PROFILE_DIRECTORY = ".patchdesk-dev";

const CDP_PORT_BASE = 9300;
const VITE_PORT_BASE = 5200;
const PORT_SPAN = 600;

/**
 * The checkout root when `directory` is inside a linked git worktree, and
 * undefined in the main checkout or outside git. A linked worktree's git dir
 * differs from the repository's common dir; the main checkout's are the same.
 *
 * @param {string} directory
 * @returns {string | undefined}
 */
export function linkedWorktreeRoot(directory) {
  try {
    const [topLevel, gitDirectory, commonDirectory] = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\n");
    if (
      topLevel === undefined ||
      gitDirectory === undefined ||
      commonDirectory === undefined
    )
      return undefined;
    return realpathSync(gitDirectory) === realpathSync(commonDirectory)
      ? undefined
      : realpathSync(topLevel);
  } catch {
    return undefined;
  }
}

/**
 * Everything a worktree's dev app needs to stay apart from the main dev app:
 * ports from a stable hash of the worktree path, roots inside the worktree,
 * and an MCP socket. The socket lives under the temp directory because a Unix
 * socket path is limited to about 100 bytes and a nested worktree path exceeds it.
 *
 * @param {string} worktreeRoot
 */
export function worktreeDevProfile(worktreeRoot) {
  const digest = createHash("sha256").update(worktreeRoot).digest();
  const short = digest.toString("hex").slice(0, 8);
  const profileRoot = join(worktreeRoot, WORKTREE_PROFILE_DIRECTORY);
  return {
    worktreeRoot,
    profileRoot,
    configDirectory: join(profileRoot, "config"),
    dataDirectory: join(profileRoot, "data"),
    cdpPort: CDP_PORT_BASE + (digest.readUInt32BE(0) % PORT_SPAN),
    vitePort: VITE_PORT_BASE + (digest.readUInt32BE(4) % PORT_SPAN),
    mcpSocket: join(tmpdir(), `patchdesk-dev-${short}`, "patchdesk.sock"),
  };
}

/**
 * The profile for the checkout containing `directory`, or undefined for the
 * main checkout. `PATCHDESK_DEV_SHARED=1` opts out, as it does for the main
 * dev app, because it asks for the installed roots.
 *
 * @param {string} directory
 * @param {Record<string, string | undefined>} env
 */
export function devProfileFor(directory, env) {
  if (env["PATCHDESK_DEV_SHARED"] === "1") return undefined;
  const root = linkedWorktreeRoot(resolve(directory));
  return root === undefined ? undefined : worktreeDevProfile(root);
}

/**
 * The environment `pnpm dev` hands the app. The main process reads
 * `PATCHDESK_DEV_PROFILE_ROOT` to place its roots, user data and ref namespace.
 *
 * @param {NonNullable<ReturnType<typeof devProfileFor>>} profile
 */
export function worktreeDevEnvironment(profile) {
  return {
    PATCHDESK_DEV_PROFILE_ROOT: profile.profileRoot,
    PATCHDESK_MCP_SOCKET: profile.mcpSocket,
    PATCHDESK_VITE_PORT: String(profile.vitePort),
    REMOTE_DEBUGGING_PORT: String(profile.cdpPort),
  };
}
