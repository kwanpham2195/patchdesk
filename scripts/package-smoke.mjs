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

import { validatePackagedFontRuntime } from "./font-package-validation.mjs";
import { validatePackageSizes } from "./package-size-validation.mjs";

import { packageSmokeEnvironment } from "./smoke-env.mjs";

const execute = promisify(execFile);

const root = resolve(import.meta.dirname, "..");
const releaseRoot = join(root, "release");
// The packaged version is whatever `package.json` says, so a release build
// smoke-tests the version it just produced instead of a number written here.
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const archFolder = process.arch === "arm64" ? "mac-arm64" : "mac";
const bundle = join(releaseRoot, archFolder, "Patchdesk.app");
const executable = join(bundle, "Contents/MacOS/Patchdesk");
const runtimeRoot = join(bundle, "Contents/Resources/insight-runtime");
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
  CFBundleShortVersionString: version,
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
await validateCodeSignature(bundle);

// Both handoff downloads sit directly in `release/`, beside the unpacked app
// this smoke reads: the disk image people install from and the zip.
const releaseFiles = await readdir(releaseRoot);
const dmgNames = releaseFiles.filter(
  (name) => name.endsWith(".dmg") && name.includes(version),
);
const zipNames = releaseFiles.filter(
  (name) => name.endsWith(".zip") && name.includes(version),
);
if (dmgNames.length !== 1)
  throw new Error(
    `release/ must hold exactly one .dmg for version ${version}, found ${dmgNames.length}: ${releaseFiles.join(", ")}`,
  );
if (zipNames.length !== 1)
  throw new Error(
    `release/ must hold exactly one .zip for version ${version}, found ${zipNames.length}: ${releaseFiles.join(", ")}`,
  );
const dmgName = dmgNames[0];
const zipName = zipNames[0];
if (dmgName === undefined || zipName === undefined)
  throw new Error("Package artifact discovery failed closed.");
const packageSizes = await validatePackageSizes({
  bundle,
  dmg: join(releaseRoot, dmgName),
  zip: join(releaseRoot, zipName),
});
console.log(
  `Package sizes: ${packageSizes
    .map(
      ({ name, measuredMiB, limitMiB }) =>
        `${name} ${measuredMiB.toFixed(2)}/${limitMiB.toFixed(2)} MiB`,
    )
    .join(", ")}`,
);

const home = await mkdtemp(join(tmpdir(), "patchdesk-package-smoke-"));
let smoke;
await makeTreeReadOnly(runtimeRoot);
try {
  const runtimeBefore = await snapshotTree(runtimeRoot);
  smoke = await runRuntimeSmoke(executable, runtimeRoot, home);
  const runtimeAfter = await snapshotTree(runtimeRoot);
  if (JSON.stringify(runtimeAfter) !== JSON.stringify(runtimeBefore))
    throw new Error("Packaged insight-runtime smoke modified app Resources.");
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
    "Packaged insight-runtime smoke fixtures did not produce the required strict results.",
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
  /** @type {string[]} */
  const fontResourceFailures = [];
  window.on("console", (message) => {
    if (message.type() === "error") rendererFailures.push(message.text());
  });
  window.on("pageerror", (error) => rendererFailures.push(error.message));
  window.on(
    "requestfailed",
    /** @param {import("playwright").Request} request */ (request) => {
      if (request.resourceType() !== "font") return;
      fontResourceFailures.push(
        `${request.url()} failed: ${request.failure()?.errorText ?? "unknown failure"}`,
      );
    },
  );
  window.on(
    "response",
    /** @param {import("playwright").Response} response */ (response) => {
      if (response.request().resourceType() !== "font" || response.ok()) return;
      fontResourceFailures.push(
        `${response.url()} returned HTTP ${response.status()}`,
      );
    },
  );
  await window.waitForLoadState("domcontentloaded");
  await window.evaluate(() => {
    window.location.hash = "workbench-fixture";
  });
  await window.reload({ waitUntil: "domcontentloaded" });
  try {
    await window
      .getByText("#42 Protect review writes", { exact: true })
      .waitFor({ timeout: 15_000 });
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
  // The fixture route never resolves a workspace profile, so cleanup stays
  // unavailable: assert the real disabled state and its explanatory copy
  // instead of an activity load that can never become clickable here.
  await settings
    .getByText("Choose a workspace profile before clearing its local data.", {
      exact: true,
    })
    .waitFor();
  const clearLocalData = settings.getByTestId("clear-local-data-button");
  if (await clearLocalData.isEnabled())
    throw new Error(
      "Packaged Settings clear-local-data button should stay disabled without an active workspace profile",
    );
  const reviewActivityCard = settings.getByTestId("review-activity-card");
  await reviewActivityCard.scrollIntoViewIfNeeded();
  await reviewActivityCard.waitFor();
  const loadActivity = settings.getByRole("button", { name: "Load activity" });
  if (await loadActivity.isEnabled())
    throw new Error(
      "Packaged Settings Load activity button should stay disabled without an active workspace profile",
    );
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
  const packagedFonts = await window.evaluate(async () => {
    await globalThis.document.fonts.ready;
    const [geistFaces, geistMonoFaces] = await Promise.all([
      globalThis.document.fonts.load('400 16px "Geist Variable"'),
      globalThis.document.fonts.load('400 16px "Geist Mono Variable"'),
    ]);
    const code = globalThis.document.createElement("code");
    code.className = "font-mono";
    globalThis.document.body.append(code);
    const codeFontFamily = globalThis.getComputedStyle(code).fontFamily;
    code.remove();
    return {
      bodyFontFamily: globalThis.getComputedStyle(globalThis.document.body)
        .fontFamily,
      codeFontFamily,
      fontFaces: [...globalThis.document.fonts].map((face) => ({
        family: face.family,
        status: face.status,
      })),
      loadedGeistFaces: geistFaces.length,
      loadedGeistMonoFaces: geistMonoFaces.length,
    };
  });
  const fontErrors = validatePackagedFontRuntime({
    ...packagedFonts,
    fontResourceFailures,
  });
  if (fontErrors.length > 0) throw new Error(fontErrors.join("\n"));
  console.log(
    `${bundle}: packaged fixture workbench loaded with Geist and Geist Mono (${metadata.CFBundleIdentifier}, ${metadata.CFBundleShortVersionString}, ${process.arch}, ${metadata.CFBundleIconFile})`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await stopPackagedApp(cdpPort);
  if (!packagedApp.killed) packagedApp.kill("SIGTERM");
  // Electron writes its shutdown lock into user-data while exiting, so the
  // directory is only safe to remove once the process is gone.
  await waitForExit(packagedApp, 10_000);
  await rm(home, { recursive: true, force: true });
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolveExit) => {
    let timer = setTimeout(() => {
      child.kill("SIGKILL");
      // Wait for the kill to land before the caller removes the home; one
      // second is ample for the kernel to reap an uncatchable SIGKILL.
      timer = setTimeout(resolveExit, 1_000);
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
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
      throw new Error(
        "Packaged insight-runtime smoke child returned invalid JSON.",
      );
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Check that the bundle's code signature seals it, and report what kind of
 * signature it is.
 *
 * This is the one thing about the download nothing else here can see. An
 * unsigned build keeps Electron's own linker-signed signature, which covers
 * the executable and nothing else, so `--verify --deep --strict` fails with
 * "code has no resources but signature indicates they must be present" and
 * macOS refuses a downloaded copy as "damaged" with no way past the dialog.
 * `scripts/sign-mac-adhoc.mjs` replaces that with an ad-hoc seal over the whole
 * bundle during packaging; this is where that is proved.
 *
 * `spctl` is reported and not enforced. It answers a different question --
 * whether the app is notarized -- and an ad-hoc signature is expected to be
 * rejected by it. A valid seal is what this smoke is asserting.
 *
 * @param {string} bundle
 * @returns {Promise<void>}
 */
async function validateCodeSignature(bundle) {
  try {
    await execute("codesign", ["--verify", "--deep", "--strict", bundle]);
  } catch (cause) {
    throw new Error(
      `Packaged bundle has no valid code signature: ${commandOutput(cause)}`,
      { cause },
    );
  }
  // `codesign -dv` writes its description to stderr and exits 0.
  const { stderr: description } = await execute("codesign", ["-dv", bundle]);
  const details = description
    .split("\n")
    .filter(
      (line) => line.startsWith("Identifier=") || line.startsWith("Signature="),
    )
    .join(", ");
  let assessment;
  try {
    const { stdout, stderr } = await execute("spctl", [
      "--assess",
      "--type",
      "execute",
      bundle,
    ]);
    assessment = `${stdout}${stderr}`.trim();
  } catch (cause) {
    assessment = commandOutput(cause);
  }
  console.log(
    `Packaged signature: ${details} (sealed and verified). spctl --assess: ${assessment || "no output"}`,
  );
}

/**
 * `execFile` rejects with an error carrying the child's own output. Reading it
 * back off the rejection is what makes a signing failure say why instead of
 * "Command failed".
 *
 * @param {unknown} cause
 * @returns {string}
 */
function commandOutput(cause) {
  const error = Object(cause);
  return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || String(cause);
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
    manifest.piVersion !== "0.84.4" ||
    manifest.nodeFloor !== ">=22.19.0" ||
    manifest.lockDigest !== lockDigest
  ) {
    throw new Error(
      "Packaged insight runtime manifest does not match its exact runtime closure.",
    );
  }
  if (
    runtimePackage.dependencies?.["@earendil-works/pi-agent-core"] !==
      "0.84.4" ||
    runtimePackage.dependencies?.["@earendil-works/pi-ai"] !== "0.84.4"
  ) {
    throw new Error(
      "Packaged insight runtime package does not contain the expected exact versions.",
    );
  }
  console.log(
    `Packaged runtime: Pi ${manifest.piVersion}, Node ${nodeVersion.trim()}`,
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
