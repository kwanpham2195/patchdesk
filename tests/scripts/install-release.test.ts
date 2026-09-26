import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installer = resolve(
  import.meta.dirname,
  "../../scripts/install-release.sh",
);
const version = "0.0.12";
const archiveName = `Patchdesk-${version}-arm64-mac.zip`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "patchdesk installer "));
  roots.push(root);
  const installDir = join(root, "Applications");
  const binDir = join(root, "bin");
  const fakeBin = join(root, "fake-bin");
  const sourceApp = join(root, "build", "Patchdesk.app");
  const archive = join(root, archiveName);
  const release = join(root, "release.json");
  mkdirSync(installDir);
  mkdirSync(binDir);
  mkdirSync(fakeBin);
  mkdirSync(join(sourceApp, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(sourceApp, "Contents", "Resources", "bin"), {
    recursive: true,
  });
  writeFileSync(
    join(sourceApp, "Contents", "MacOS", "Patchdesk"),
    "app binary",
  );
  writeFileSync(
    join(sourceApp, "Contents", "Resources", "bin", "patchdesk"),
    "command binary",
  );
  const zip = spawnSync("ditto", [
    "-c",
    "-k",
    "--keepParent",
    sourceApp,
    archive,
  ]);
  if (zip.status !== 0) throw new Error(zip.stderr.toString());
  const digest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  const writeRelease = (fields: { tag?: string; digest?: string } = {}) => {
    writeFileSync(
      release,
      JSON.stringify({
        tag_name: fields.tag ?? `v${version}`,
        assets: [
          { name: archiveName, digest: fields.digest ?? `sha256:${digest}` },
        ],
      }),
    );
  };
  writeRelease();
  writeFileSync(
    join(fakeBin, "curl"),
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    -fsSL) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  https://api.github.com/repos/kwanpham2195/patchdesk/releases/latest)
    cp "$PATCHDESK_FIXTURE_RELEASE" "$output" ;;
  https://github.com/kwanpham2195/patchdesk/releases/download/*)
    cp "$PATCHDESK_FIXTURE_ARCHIVE" "$output" ;;
  *) exit 22 ;;
esac
`,
    { mode: 0o755 },
  );
  const run = () =>
    spawnSync("/bin/sh", [installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PATCHDESK_INSTALL_DIR: installDir,
        PATCHDESK_BIN_DIR: binDir,
        PATCHDESK_FIXTURE_RELEASE: release,
        PATCHDESK_FIXTURE_ARCHIVE: archive,
      },
    });
  return { root, installDir, binDir, fakeBin, release, run, writeRelease };
}

describe("release installer", () => {
  it("installs the verified app and links its command", () => {
    const { installDir, binDir, run } = fixture();

    const result = run();

    expect(result.status).toBe(0);
    expect(
      readFileSync(
        join(installDir, "Patchdesk.app/Contents/MacOS/Patchdesk"),
        "utf8",
      ),
    ).toBe("app binary");
    expect(readlinkSync(join(binDir, "patchdesk"))).toBe(
      join(installDir, "Patchdesk.app/Contents/Resources/bin/patchdesk"),
    );
    expect(result.stderr).toContain(`Installed Patchdesk ${version}`);
  });

  it("rejects a download whose checksum differs from the release", () => {
    const { installDir, binDir, run, writeRelease } = fixture();
    writeRelease({ digest: `sha256:${"0".repeat(64)}` });

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Download checksum does not match");
    expect(existsSync(join(installDir, "Patchdesk.app"))).toBe(false);
    expect(existsSync(join(binDir, "patchdesk"))).toBe(false);
  });

  it("leaves an existing app intact", () => {
    const { installDir, binDir, run } = fixture();
    const app = join(installDir, "Patchdesk.app");
    mkdirSync(app);
    writeFileSync(join(app, "existing.txt"), "previous installation");

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already installed");
    expect(readFileSync(join(app, "existing.txt"), "utf8")).toBe(
      "previous installation",
    );
    expect(existsSync(join(binDir, "patchdesk"))).toBe(false);
  });

  it("leaves an existing command intact", () => {
    const { installDir, binDir, run } = fixture();
    const command = join(binDir, "patchdesk");
    writeFileSync(command, "another command");

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Command path already exists");
    expect(readFileSync(command, "utf8")).toBe("another command");
    expect(existsSync(join(installDir, "Patchdesk.app"))).toBe(false);
  });

  it("removes the new app if linking the command fails", () => {
    const { installDir, binDir, fakeBin, run } = fixture();
    writeFileSync(join(fakeBin, "ln"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not link the patchdesk command");
    expect(existsSync(join(installDir, "Patchdesk.app"))).toBe(false);
    expect(existsSync(join(binDir, "patchdesk"))).toBe(false);
  });
});
