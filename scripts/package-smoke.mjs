import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { chromium } from "playwright";

import { packageSmokeEnvironment } from "./smoke-env.mjs";

const execute = promisify(execFile);

const root = resolve(import.meta.dirname, "..");
const archFolder = process.arch === "arm64" ? "mac-arm64" : "mac";
const bundle = join(root, "release", archFolder, "Patchdesk.app");
const executable = join(bundle, "Contents/MacOS/Patchdesk");
const runtimeRoot = join(bundle, "Contents/Resources/flue-runtime");
await validatePackagedRuntime(executable, runtimeRoot);
const plist = join(bundle, "Contents/Info.plist");
await access(executable);
await Promise.all([
  access(join(runtimeRoot, "package-smoke-runner.js")),
  access(join(runtimeRoot, "runtime-manifest.json")),
]);
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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows the raw plist-derived JSON's CFBundleIconFile field at this exact I/O boundary; no earlier parser exists for this primitive shape.
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
let smoke;
await makeTreeReadOnly(runtimeRoot);
try {
  const runtimeBefore = await snapshotTree(runtimeRoot);
  smoke = await runRuntimeSmoke(executable, runtimeRoot, home);
  const runtimeAfter = await snapshotTree(runtimeRoot);
  if (JSON.stringify(runtimeAfter) !== JSON.stringify(runtimeBefore))
    throw new Error("Packaged Flue smoke modified app Resources.");
} finally {
  await makeTreeWritable(runtimeRoot);
}
if (
  !smoke?.walkthrough?.ok ||
  !smoke.analysis?.ok ||
  smoke.analysisCallNineDenied !== true ||
  smoke.cancellation?.reason !== "cancelled"
)
  throw new Error(
    "Packaged Flue smoke fixtures did not produce the required strict results.",
  );
const cdpPort = 20_000 + Math.floor(Math.random() * 20_000);
const packagedApp = spawn(
  executable,
  [
    `--user-data-dir=${join(home, "user-data")}`,
    `--remote-debugging-port=${cdpPort}`,
  ],
  {
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    stdio: "ignore",
  },
);
let browser;
try {
  browser = await connectToPackagedApp(cdpPort);
  const context = browser.contexts()[0];
  const window =
    context === undefined ? undefined : await waitForWindow(context);
  if (window === undefined)
    throw new Error("Packaged app did not create a window");
  const rendererFailures = [];
  window.on("console", (message) => {
    if (message.type() === "error") rendererFailures.push(message.text());
  });
  window.on("pageerror", (error) => rendererFailures.push(error.message));
  await window.waitForLoadState("domcontentloaded");
  await window.evaluate(() => {
    window.location.hash = "workbench-fixture";
  });
  await window.reload({ waitUntil: "domcontentloaded" });
  try {
    await window
      .getByText("Review state is current.", { exact: true })
      .waitFor({ timeout: 15_000 });
    await window
      .getByText("#42 Protect review writes", { exact: true })
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
  if ((await generalTab.getAttribute("aria-selected")) !== "true")
    throw new Error("Packaged Settings did not open on the General tab");
  const workspaceTab = settings.getByRole("tab", { name: "Workspace" });
  await workspaceTab.click();
  await settings.getByTestId("settings-section-workspace").waitFor();
  await settings.getByTestId("workspace-scope").waitFor();
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
    throw new Error(
      `Packaged Settings content is not independently scrollable: ${JSON.stringify(scrollMetrics)}`,
    );
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

async function runRuntimeSmoke(executable, runtime, home) {
  const credentials = [
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_API_KEY",
  ];
  const previous = new Map(credentials.map((key) => [key, process.env[key]]));
  try {
    for (const key of credentials) process.env[key] = "must-not-reach-child";
    const environment = packageSmokeEnvironment(home);
    if (credentials.some((key) => Object.hasOwn(environment, key)))
      throw new Error(
        "Package smoke environment inherited a provider credential.",
      );
    const { stdout } = await execute(
      executable,
      [join(runtime, "package-smoke-runner.js")],
      { env: environment, maxBuffer: 2 * 1024 * 1024 },
    );
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error("Packaged Flue smoke child returned invalid JSON.");
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function validatePackagedRuntime(executable, runtime) {
  const environment = packageSmokeEnvironment(tmpdir());
  const { stdout: nodeVersion } = await execute(
    executable,
    ["-p", "process.versions.node"],
    { env: environment },
  );
  if (!meetsNodeFloor(nodeVersion.trim(), [22, 19, 0]))
    throw new Error(
      `Packaged Electron Node ${nodeVersion.trim()} is below 22.19.0.`,
    );
  const [manifestRaw, packageRaw, lock] = await Promise.all([
    readFile(join(runtime, "runtime-manifest.json"), "utf8"),
    readFile(join(runtime, "package.json"), "utf8"),
    readFile(join(runtime, "pnpm-lock.yaml")),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const runtimePackage = JSON.parse(packageRaw);
  const lockDigest = createHash("sha256").update(lock).digest("hex");
  if (
    manifest.flueVersion !== "2.0.3" ||
    manifest.piVersion !== "0.84.1" ||
    manifest.nodeFloor !== ">=22.19.0" ||
    manifest.lockDigest !== lockDigest
  ) {
    throw new Error(
      "Packaged Flue runtime manifest does not match its exact runtime closure.",
    );
  }
  if (
    runtimePackage.dependencies?.["@flue/runtime"] !== "2.0.3" ||
    runtimePackage.dependencies?.["@earendil-works/pi-ai"] !== "0.84.1"
  ) {
    throw new Error(
      "Packaged Flue runtime package does not contain the expected exact versions.",
    );
  }
  console.log(
    `Packaged runtime: Flue ${manifest.flueVersion}, Pi ${manifest.piVersion}, Node ${nodeVersion.trim()}`,
  );
}

function meetsNodeFloor(version, floor) {
  const parts = version.split(".").map(Number);
  if (
    parts.length < 3 ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  )
    return false;
  for (let index = 0; index < floor.length; index += 1) {
    if (parts[index] > floor[index]) return true;
    if (parts[index] < floor[index]) return false;
  }
  return true;
}

async function makeTreeReadOnly(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await makeTreeReadOnly(path);
    else if (entry.isFile()) await chmod(path, 0o444);
  }
  await chmod(root, 0o555);
}
async function makeTreeWritable(root) {
  await chmod(root, 0o755).catch(() => undefined);
  for (const entry of await readdir(root, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(path);
    else if (entry.isFile()) await chmod(path, 0o644);
  }
}

async function snapshotTree(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = join(relative, entry.name);
    if (entry.isDirectory())
      snapshot.push(...(await snapshotTree(root, child)));
    else if (entry.isFile()) {
      const metadata = await stat(join(root, child));
      snapshot.push([child, metadata.size, metadata.mtimeMs]);
    } else snapshot.push([child, entry.isSymbolicLink() ? "symlink" : "other"]);
  }
  return snapshot;
}
