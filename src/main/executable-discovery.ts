import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const macDesktopPaths = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export async function discoverExecutable(
  executable: string,
  pathValue = process.env.PATH,
): Promise<string | undefined> {
  if (isAbsolute(executable) || executable.includes("/")) {
    return (await executableFile(executable)) ? executable : undefined;
  }
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

/** Resolves a command only through the supplied inherited PATH. */
export async function discoverPathOnlyExecutable(
  executable: string,
  pathValue = process.env.PATH,
): Promise<string | undefined> {
  if (isAbsolute(executable) || executable.includes("/")) return undefined;
  for (const directory of new Set(
    pathValue?.split(delimiter).filter((value) => value.length > 0) ?? [],
  )) {
    const candidate = join(directory, executable);
    if (await executableFile(candidate)) return candidate;
  }
  return undefined;
}
