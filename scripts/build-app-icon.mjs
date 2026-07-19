import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "resources/branding/patchdesk-logo.svg");
const output = join(root, "resources/icons/patchdesk.icns");
const iconset = join(root, "resources/icons/Patchdesk.iconset");
const sizes = [16, 32, 128, 256, 512];

await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });
for (const size of sizes) {
  await sharp(source).resize(size, size).png().toFile(join(iconset, `icon_${size}x${size}.png`));
  await sharp(source).resize(size * 2, size * 2).png().toFile(join(iconset, `icon_${size}x${size}@2x.png`));
}
await run("/usr/bin/iconutil", ["--convert", "icns", "--output", output, iconset]);
await rm(iconset, { recursive: true, force: true });
console.log(output);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
}
