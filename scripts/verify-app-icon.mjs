import { access, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "resources/branding/patchdesk-logo.svg");
const icon = join(root, "resources/icons/patchdesk.icns");
await access(source);
const iconStat = await stat(icon);
if (iconStat.size < 10_000)
  throw new Error("Patchdesk.icns is missing required icon representations");
console.log(`Patchdesk icon verified (${iconStat.size} bytes)`);
