import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { whenLoginShellEnvironmentImported } from "./login-shell-import";

const macDesktopPaths = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

/**
 * Resolves a command through the supplied PATH, then the macOS fallback
 * directories. Given no PATH it reads this process's, which the login shell
 * may still be replacing, so it waits for that import first (ADR 0038,
 * amended 2026-09-19) — a `gh` installed by mise, nix, or asdf is on the
 * imported PATH and on no fallback list.
 */
export async function discoverExecutable(
  executable: string,
  suppliedPath?: string,
): Promise<string | undefined> {
  if (isAbsolute(executable) || executable.includes("/")) {
    return (await executableFile(executable)) ? executable : undefined;
  }
  if (suppliedPath === undefined) await whenLoginShellEnvironmentImported();
  const pathValue = suppliedPath ?? process.env.PATH;
  const search = [
    ...(pathValue?.split(delimiter).filter((value) => value.length > 0) ?? []),
    ...(process.platform === "darwin" ? macDesktopPaths : []),
  ];
  for (const directory of new Set(search)) {
    const candidate = join(directory, executable);
    if (await executableFile(candidate)) return candidate;
  }
  return undefined;
}

async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a command only through the supplied inherited PATH. Given none it
 * reads this process's, which the login shell may still be replacing, so it
 * waits for that import first — this is the Codex discovery ADR 0038 names
 * (amended 2026-09-19).
 */
export async function discoverPathOnlyExecutable(
  executable: string,
  suppliedPath?: string,
): Promise<string | undefined> {
  if (isAbsolute(executable) || executable.includes("/")) return undefined;
  if (suppliedPath === undefined) await whenLoginShellEnvironmentImported();
  const pathValue = suppliedPath ?? process.env.PATH;
  for (const directory of new Set(
    pathValue?.split(delimiter).filter((value) => value.length > 0) ?? [],
  )) {
    const candidate = join(directory, executable);
    if (await executableFile(candidate)) return candidate;
  }
  return undefined;
}
