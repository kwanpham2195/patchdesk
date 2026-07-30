import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { chromium } from "playwright";

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
const cdpPort = 20_000 + Math.floor(Math.random() * 20_000);
const packagedApp = spawn(executable, [
  `--user-data-dir=${join(home, "user-data")}`,
  `--remote-debugging-port=${cdpPort}`,
], {
  env: {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PATCHDESK_PACKAGE_SMOKE: "1",
  },
  stdio: "ignore",
});
let browser;
try {
  browser = await connectToPackagedApp(cdpPort);
  const context = browser.contexts()[0];
  const window = context === undefined
    ? undefined
    : await waitForWindow(context);
  if (window === undefined) throw new Error("Packaged app did not create a window");
  const rendererFailures = [];
  window.on("console", (message) => {
    if (message.type() === "error") rendererFailures.push(message.text());
  });
  window.on("pageerror", (error) => rendererFailures.push(error.message));
  await window.waitForLoadState("domcontentloaded");
  try {
    await window
      .getByText("Review complete", { exact: true })
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
  await window.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = window.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  const generalTab = settings.getByRole("tab", { name: "General" });
  await generalTab.waitFor();
  if (await generalTab.getAttribute("aria-selected") !== "true")
    throw new Error("Packaged Settings did not open on the General tab");
  const workspaceTab = settings.getByRole("tab", { name: "Workspace" });
  await workspaceTab.click();
  await settings.getByTestId("settings-section-workspace").waitFor();
  await settings.getByTestId("watchlist-management").waitFor();
  const dataTab = settings.getByRole("tab", { name: "Data & recovery" });
  await dataTab.click();
  await settings.getByTestId("settings-section-data").waitFor();
  await settings.getByTestId("local-review-data-card").waitFor();
  const reviewActivityCard = settings.getByTestId("review-activity-card");
  await reviewActivityCard.scrollIntoViewIfNeeded();
  await reviewActivityCard.waitFor();
  const loadActivity = settings.getByRole("button", { name: "Load activity" });
  await loadActivity.click();
  await settings
    .getByText("No local review activity yet.", { exact: true })
    .waitFor();
  const settingsViewport = window
    .getByTestId("settings-scroll-region")
    .locator('[data-slot="scroll-area-viewport"]');
  await settingsViewport.waitFor();
  const scrollMetrics = await settingsViewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: window.getComputedStyle(element).overflowY,
  }));
  if (scrollMetrics.overflowY !== "scroll")
    throw new Error(`Packaged Settings content is not independently scrollable: ${JSON.stringify(scrollMetrics)}`);
  console.log(
    `${bundle}: packaged fixture workbench loaded (${metadata.CFBundleIdentifier}, ${metadata.CFBundleShortVersionString}, ${process.arch}, ${metadata.CFBundleIconFile})`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await stopPackagedApp(cdpPort);
  if (!packagedApp.killed) packagedApp.kill("SIGTERM");
  await rm(home, { recursive: true, force: true });
}

async function connectToPackagedApp(port) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Packaged app did not expose DevTools on port ${port}: ${String(lastError)}`,
  );
}

async function waitForWindow(context) {
  const existing = context.pages()[0];
  if (existing !== undefined) return existing;
  return await context.waitForEvent("page", { timeout: 15_000 });
}

async function stopPackagedApp(port) {
  try {
    const { stdout } = await execute("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    const pid = stdout.trim().split("\n")[0];
    if (pid !== undefined && /^\d+$/.test(pid))
      await execute("kill", ["-TERM", pid]);
  } catch {
    // The process may have already exited after the browser disconnects.
  }
}
