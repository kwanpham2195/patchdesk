import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { _electron as electron } from "playwright";

const execute = promisify(execFile);

const root = resolve(import.meta.dirname, "..");
const archFolder = process.arch === "arm64" ? "mac-arm64" : "mac";
const bundle = join(root, "release", archFolder, "Patchdesk.app");
const executable = join(bundle, "Contents/MacOS/Patchdesk");
const plist = join(bundle, "Contents/Info.plist");
await access(executable);
const { stdout: plistJson } = await execute("plutil", [
  "-convert",
  "json",
  "-o",
  "-",
  plist,
]);
const metadata = JSON.parse(plistJson);
const expectedMetadata = {
  CFBundleDisplayName: "Patchdesk",
  CFBundleName: "Patchdesk",
  CFBundleExecutable: "Patchdesk",
  CFBundleIdentifier: "com.centraldigital.patchdesk",
  CFBundleShortVersionString: "0.1.0",
};
for (const [name, expected] of Object.entries(expectedMetadata)) {
  if (metadata[name] !== expected)
    throw new Error(
      `Packaged metadata ${name} was ${String(metadata[name])}, expected ${expected}`,
    );
}
if (
  typeof metadata.CFBundleIconFile !== "string" ||
  metadata.CFBundleIconFile.length === 0
)
  throw new Error("Packaged metadata has no CFBundleIconFile");
await access(join(bundle, "Contents/Resources", metadata.CFBundleIconFile));
const { stdout: executableKind } = await execute("file", [executable]);
if (!executableKind.includes(process.arch))
  throw new Error(
    `Packaged executable architecture mismatch: ${executableKind.trim()}`,
  );

const home = await mkdtemp(join(tmpdir(), "patchdesk-package-smoke-"));
const application = await electron.launch({
  executablePath: executable,
  args: [`--user-data-dir=${join(home, "user-data")}`],
  env: {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PATCHDESK_PACKAGE_SMOKE: "1",
  },
});
try {
  const window = await application.firstWindow();
  const rendererFailures = [];
  window.on("console", (message) => {
    if (message.type() === "error") rendererFailures.push(message.text());
  });
  window.on("pageerror", (error) => rendererFailures.push(error.message));
  await window.waitForLoadState("domcontentloaded");
  try {
    await window
      .getByText("Completed review", { exact: true })
      .waitFor({ timeout: 15_000 });
    await window
      .getByText("centraldigital/patchdesk#42", { exact: false })
      .waitFor();
  } catch (cause) {
    const state = {
      url: window.url(),
      title: await window.title(),
      body: (await window.locator("body").innerText()).slice(0, 2_000),
      rendererFailures,
    };
    throw new Error(
      `Packaged workbench fixture did not load: ${JSON.stringify(state)}`,
      { cause },
    );
  }
  const title = await window.title();
  if (!title.includes("Patchdesk"))
    throw new Error(`Unexpected packaged title: ${title}`);
  const environmentResponse = await window.evaluate(() =>
    window.patchdesk.request({ path: "/v1/environment" }),
  );
  if (!environmentResponse.ok) {
    throw new Error(
      `Packaged environment request failed: ${JSON.stringify(environmentResponse)}`,
    );
  }
  await window.evaluate(() =>
    window.history.replaceState(null, "", window.location.pathname),
  );
  await window.reload({ waitUntil: "domcontentloaded" });
  await window.getByRole("button", { name: "Settings" }).click();
  await window.getByRole("heading", { name: "About Patchdesk" }).waitFor();
  await window.getByText("Version 0.1.0").waitFor({ timeout: 15_000 });
  await window.getByText("Unsigned internal build").waitFor();
  console.log(
    `${bundle}: packaged fixture workbench loaded (${metadata.CFBundleIdentifier}, ${metadata.CFBundleShortVersionString}, ${process.arch}, ${metadata.CFBundleIconFile})`,
  );
} finally {
  await application.close();
  await rm(home, { recursive: true, force: true });
}
